import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import { classifyTeamWaitPeer, waitForTeam } from "../src/utils/team-wait";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../src/utils/atomic-file";
import { resolveAgentRole } from "../src/utils/agent-role";
import { applyTeamSystemPrompt, buildLeadSystemPrompt, buildTeammateSystemPrompt } from "../src/utils/team-prompts";
import { buildPiCommand, getPiLaunchCommand } from "../src/utils/pi-command";
import { Member, THINKING_LEVELS } from "../src/utils/models";
import {
  type AgentSettings,
  loadAgentSettings,
  resolveTeammateModel,
  resolveTeammateThinking,
} from "../src/utils/agent-settings";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import * as predefined from "../src/utils/predefined-teams";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute

/**
 * Query available models from pi --list-models
 */
function getAvailableModels(): Array<{ provider: string; model: string }> {
  const now = Date.now();
  if (availableModelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return availableModelsCache;
  }

  try {
    const result = spawnSync("pi", ["--list-models"], {
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status !== 0 || !result.stdout) {
      return [];
    }

    const models: Array<{ provider: string; model: string }> = [];
    const lines = result.stdout.split("\n");

    for (const line of lines) {
      // Skip header line and empty lines
      if (!line.trim() || line.startsWith("provider")) continue;

      // Parse: provider model context max-out thinking images
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const provider = parts[0];
        const model = parts[1];
        if (provider && model) {
          models.push({ provider, model });
        }
      }
    }

    availableModelsCache = models;
    modelsCacheTime = now;
    return models;
  } catch (e) {
    return [];
  }
}

/**
 * Provider priority list - OAuth/subscription providers first (cheaper), then API-key providers
 */
const PROVIDER_PRIORITY = [
  // OAuth / Subscription providers (typically free/cheaper)
  "google-gemini-cli",  // Google Gemini CLI - OAuth, free tier
  "github-copilot",     // GitHub Copilot - subscription
  "kimi-sub",           // Kimi subscription
  // API key providers
  "anthropic",
  "openai",
  "google",
  "zai",
  "openrouter",
  "azure-openai",
  "amazon-bedrock",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "vercel-ai-gateway",
];

/**
 * Find the best matching provider for a given model name.
 * Returns the full provider/model string or null if not found.
 */
function resolveModelWithProvider(modelName: string): string | null {
  // If already has provider prefix, return as-is
  if (modelName.includes("/")) {
    return modelName;
  }

  const availableModels = getAvailableModels();
  if (availableModels.length === 0) {
    return null;
  }

  const lowerModelName = modelName.toLowerCase();

  // Find all exact matches (case-insensitive) and sort by provider priority
  const exactMatches = availableModels.filter(
    (m) => m.model.toLowerCase() === lowerModelName
  );

  if (exactMatches.length > 0) {
    // Sort by provider priority (lower index = higher priority)
    exactMatches.sort((a, b) => {
      const aIndex = PROVIDER_PRIORITY.indexOf(a.provider);
      const bIndex = PROVIDER_PRIORITY.indexOf(b.provider);
      // If provider not in priority list, put it at the end
      const aPriority = aIndex === -1 ? 999 : aIndex;
      const bPriority = bIndex === -1 ? 999 : bIndex;
      return aPriority - bPriority;
    });
    return `${exactMatches[0].provider}/${exactMatches[0].model}`;
  }

  // Try partial match (model name contains the search term)
  const partialMatches = availableModels.filter((m) =>
    m.model.toLowerCase().includes(lowerModelName)
  );

  if (partialMatches.length > 0) {
    for (const preferredProvider of PROVIDER_PRIORITY) {
      const match = partialMatches.find(
        (m) => m.provider === preferredProvider
      );
      if (match) {
        return `${match.provider}/${match.model}`;
      }
    }
    // Return first match if no preferred provider found
    return `${partialMatches[0].provider}/${partialMatches[0].model}`;
  }

  return null;
}

/**
 * Find the team this session is the lead for (if any).
 * Checks the lead-session.json file to match PID.
 */
function findLeadTeamForSession(): string | null {
  try {
    const teamsDir = paths.TEAMS_DIR;
    if (!fs.existsSync(teamsDir)) return null;

    for (const teamDir of fs.readdirSync(teamsDir)) {
      const sessionFile = paths.leadSessionPath(teamDir);
      if (fs.existsSync(sessionFile)) {
        try {
          const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
          const currentStartToken = runtime.getProcessStartToken(process.pid);
          const tokenMatches = session.processStartToken === undefined
            ? fs.existsSync(paths.configPath(teamDir))
            : session.processStartToken === currentStartToken;
          if (session.pid === process.pid && tokenMatches) {
            return teamDir;
          }
        } catch {
          // Ignore corrupted session files
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Register this session as the lead for a team.
 */
function registerLeadSession(teamName: string) {
  const sessionFile = paths.leadSessionPath(teamName);
  const dir = path.dirname(sessionFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJsonSync(sessionFile, {
    pid: process.pid,
    processStartToken: runtime.getProcessStartToken(process.pid),
    startedAt: Date.now(),
  });
}

/**
 * Check if a process with the given PID is still alive.
 */
function isPidAlive(pid: number, processStartToken?: string): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    if (processStartToken) {
      const currentToken = runtime.getProcessStartToken(pid);
      if (currentToken !== undefined && currentToken !== processStartToken) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up a stale team if the lead process is dead.
 * Kills all teammate panes/windows and removes all state files.
 * Returns true if cleanup was performed, false otherwise.
 */
function cleanupStaleTeam(teamName: string, terminal: any): boolean {
  const sessionFile = paths.leadSessionPath(teamName);
  const configFile = paths.configPath(teamName);
  
  if (!fs.existsSync(sessionFile) || !fs.existsSync(configFile)) {
    return false;
  }
  
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    
    // Only cleanup if the lead PID is actually dead
    if (session.pid && !isPidAlive(session.pid, session.processStartToken)) {
      // Read config to get member info for cleanup
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        
        // Kill all teammate panes/windows
        for (const member of config.members || []) {
          if (member.name === "team-lead") continue;
          
          // Kill via PID file
          const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
          if (fs.existsSync(pidFile)) {
            try {
              const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
              const runtimeFile = paths.runtimeStatusPath(teamName, member.name);
              const status = fs.existsSync(runtimeFile)
                ? JSON.parse(fs.readFileSync(runtimeFile, "utf-8")) as runtime.AgentRuntimeStatus
                : undefined;
              if (
                status?.pid === pid &&
                status.processStartToken !== undefined &&
                runtime.isRuntimeProcessAlive(status)
              ) {
                process.kill(pid, "SIGKILL");
              }
              fs.unlinkSync(pidFile);
            } catch {}
          }
          
          // Kill via terminal adapter
          if (terminal) {
            if (member.windowId) {
              try { terminal.killWindow(member.windowId); } catch {}
            }
            if (member.tmuxPaneId) {
              try { terminal.kill(member.tmuxPaneId); } catch {}
            }
          }
        }
      } catch {}
      
      // Delete entire team directory
      const teamDirectory = paths.teamDir(teamName);
      if (fs.existsSync(teamDirectory)) {
        fs.rmSync(teamDirectory, { recursive: true });
      }
      
      // Delete tasks directory
      const tasksDirectory = paths.taskDir(teamName);
      if (fs.existsSync(tasksDirectory)) {
        fs.rmSync(tasksDirectory, { recursive: true });
      }
      
      return true;
    }
  } catch {}
  
  return false;
}

/**
 * Clean up orphaned agent session folders from ~/.pi/agent/teams/
 * These are created by the pi core system when agents are spawned.
 * We remove folders that are older than 24 hours to avoid deleting active sessions.
 * Returns the number of folders cleaned up.
 */
function cleanupAgentSessionFolders(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const agentTeamsDir = path.join(os.homedir(), ".pi", "agent", "teams");
  if (!fs.existsSync(agentTeamsDir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  for (const dir of fs.readdirSync(agentTeamsDir)) {
    const sessionDir = path.join(agentTeamsDir, dir);
    const configFile = path.join(sessionDir, "config.json");

    try {
      // Check if this is a directory with a config.json
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      if (!fs.existsSync(configFile)) continue;

      // Read the config to check the creation time
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const createdAt = config.createdAt ? new Date(config.createdAt).getTime() : 0;

      // If the folder is older than maxAgeMs, delete it
      if (createdAt > 0 && (now - createdAt) > maxAgeMs) {
        fs.rmSync(sessionDir, { recursive: true });
        cleaned++;
      }
    } catch {
      // Ignore errors for individual folders
    }
  }

  return cleaned;
}

export default function (pi: ExtensionAPI) {
  const { agentName, isTeammate } = resolveAgentRole(process.env.PI_AGENT_NAME);
  const runtimeInstanceId = randomUUID();
  const processStartToken = runtime.getProcessStartToken(process.pid);
  let incomingLeadHandoffToken = process.env.PI_TEAM_HANDOFF_TOKEN;
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  const envTeamName = process.env.PI_TEAM_NAME;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || findLeadTeamForSession();
  let teamName = detectedTeamName;

  const terminal = getTerminalAdapter();

  let inboxPollingStarted = false;
  let inboxDeliveryInFlight = false;
  let inboxPollingTimer: ReturnType<typeof setInterval> | undefined;
  let sessionCtx: any = null;
  let agentLoopActive = false;

  function formatInboxDelivery(messages: Array<{ id: string; from: string; timestamp: string; summary?: string; text: string }>): string {
    return [
      "[pi-teams inbox delivery]",
      ...messages.flatMap(message => [
        "",
        `From: ${message.from}`,
        `Message-ID: ${message.id}`,
        `Sent: ${message.timestamp}`,
        ...(message.summary ? [`Summary: ${message.summary}`] : []),
        "",
        message.text,
      ]),
    ].join("\n");
  }

  async function deliverUnreadInbox(): Promise<void> {
    if (inboxDeliveryInFlight || agentLoopActive || !teamName || !sessionCtx?.isIdle()) return;
    inboxDeliveryInFlight = true;
    try {
      const leaseBeforeRead = await runtime.readRuntimeStatus(teamName, agentName);
      if (leaseBeforeRead?.instanceId !== runtimeInstanceId) return;
      // Only agent_settled transitions work from running to idle. Inbox polling
      // must not race a newly started agent loop and misclassify it as idle.
      if (leaseBeforeRead.activity === "running" || leaseBeforeRead.activity === "waiting" || leaseBeforeRead.activity === "stopped") return;

      const unread = await messaging.readInbox(teamName, agentName, true, false);
      if (unread.length === 0 || !sessionCtx.isIdle() || agentLoopActive) {
        if (leaseBeforeRead.activity === "queued") {
          await runtime.updateRuntimeStatusForInstance(
            teamName,
            agentName,
            runtimeInstanceId,
            { activity: "idle", lastHeartbeatAt: Date.now() },
            "queued",
          );
        }
        return;
      }
      if (leaseBeforeRead.activity === "idle") {
        await runtime.markRuntimeQueuedIfIdle(teamName, agentName);
      }
      const leaseBeforeDelivery = await runtime.readRuntimeStatus(teamName, agentName);
      if (leaseBeforeDelivery?.instanceId !== runtimeInstanceId) return;
      const deliveryBatch = unread.slice(0, 1);

      // sendUserMessage is synchronous. Acknowledging only after it returns gives
      // at-least-once delivery without losing messages appended concurrently.
      pi.sendUserMessage(formatInboxDelivery(deliveryBatch));
      const leaseAfterDelivery = await runtime.readRuntimeStatus(teamName, agentName);
      if (leaseAfterDelivery?.instanceId !== runtimeInstanceId) return;
      await messaging.markMessagesRead(teamName, agentName, deliveryBatch.map(message => message.id));
      await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        lastInboxReadAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      });
    } catch (error) {
      if (teamName) {
        await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
          lastHeartbeatAt: Date.now(),
          lastError: runtime.createRuntimeError(error),
        }).catch(() => undefined);
      }
    } finally {
      inboxDeliveryInFlight = false;
    }
  }

  function startInboxPolling() {
    if (inboxPollingStarted || !sessionCtx || !teamName) return;
    inboxPollingStarted = true;
    void deliverUnreadInbox();
    inboxPollingTimer = setInterval(() => void deliverUnreadInbox(), 1000);
  }

  function stopInboxPolling() {
    if (inboxPollingTimer) clearInterval(inboxPollingTimer);
    inboxPollingTimer = undefined;
    inboxPollingStarted = false;
  }

  pi.on("session_start", async (_event, ctx) => {
    paths.ensureDirs();
    sessionCtx = ctx;

    if (isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
        atomicWriteFileSync(pidFile, process.pid.toString());
        await runtime.setRuntimeActivity(teamName, agentName, "starting", {
          instanceId: runtimeInstanceId,
          pid: process.pid,
          processStartToken,
          startedAt: Date.now(),
          activityChangedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          lastError: undefined,
        });
        startInboxPolling();
      }
      ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");
      ctx.ui.setStatus("00-pi-teams", `[${agentName.toUpperCase()}]`);

      if (terminal) {
        const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
        const setIt = () => {
          if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
          terminal.setTitle(fullTitle);
        };
        setIt();
        setTimeout(setIt, 500);
        setTimeout(setIt, 2000);
        setTimeout(setIt, 5000);
      }

    } else if (teamName) {
      // Lead reconnecting to an existing team
      ctx.ui.setStatus("pi-teams", `Lead @ ${teamName}`);
      const startedAt = Date.now();
      const handoffToken = incomingLeadHandoffToken;
      incomingLeadHandoffToken = undefined;
      const leadRuntime = handoffToken
        ? await runtime.replaceRuntimeInstance(
          teamName,
          agentName,
          handoffToken,
          runtimeInstanceId,
          {
            activity: ctx.isIdle() ? "idle" : "running",
            pid: process.pid,
            processStartToken,
            startedAt,
            activityChangedAt: startedAt,
            lastHeartbeatAt: startedAt,
            lastError: undefined,
          },
          "starting",
        )
        : await runtime.setRuntimeActivity(teamName, agentName, ctx.isIdle() ? "idle" : "running", {
          instanceId: runtimeInstanceId,
          pid: process.pid,
          processStartToken,
          startedAt,
          activityChangedAt: startedAt,
          lastHeartbeatAt: startedAt,
          lastError: undefined,
        });
      if (!leadRuntime) {
        ctx.ui.notify(`Lead handoff for team ${teamName} is no longer valid.`, "error");
        stopInboxPolling();
        teamName = null;
        setTimeout(() => ctx.shutdown(), 0);
        return;
      }
      registerLeadSession(teamName);
      startInboxPolling();
    }
  });

  pi.on("agent_start", async () => {
    agentLoopActive = true;
    if (!teamName) return;
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      activity: "running",
      pid: process.pid,
      processStartToken,
      lastHeartbeatAt: Date.now(),
      lastError: undefined,
    });
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
      if (terminal) terminal.setTitle(fullTitle);
    }
    if (teamName) {
      await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, { lastHeartbeatAt: Date.now() });
    }
  });

  pi.on("agent_settled", async () => {
    agentLoopActive = false;
    if (!teamName) return;
    try {
      const lease = await runtime.readRuntimeStatus(teamName, agentName);
      if (lease?.instanceId !== runtimeInstanceId) return;
      const hasUnreadWork = (await messaging.readInbox(teamName, agentName, true, false)).length > 0;
      const settled = await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        activity: hasUnreadWork ? "queued" : "idle",
        pid: process.pid,
        processStartToken,
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      });

      if (!settled || hasUnreadWork || !isTeammate) return;
      const ownedTasks = (await tasks.listTasks(teamName))
        .filter(task => task.owner === agentName && task.status !== "completed" && task.status !== "deleted")
        .map(task => ({ id: task.id, subject: task.subject, status: task.status }));
      const taskLines = ownedTasks.length > 0
        ? ownedTasks.map(task => `- ${task.id} [${task.status}] ${task.subject}`)
        : ["- none"];
      const stillIdle = await runtime.readRuntimeStatus(teamName, agentName);
      if (stillIdle?.instanceId !== runtimeInstanceId || stillIdle.activity !== "idle") return;
      await messaging.sendPlainMessage(
        teamName,
        agentName,
        "team-lead",
        [`Agent ${agentName} is idle.`, "Owned unfinished tasks:", ...taskLines].join("\n"),
        `${agentName} is idle`,
      );
    } catch (error) {
      await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        activity: "idle",
        lastError: runtime.createRuntimeError(error),
      }).catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    agentLoopActive = false;
    stopInboxPolling();
    if (!teamName) return;
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      activity: "stopped",
      pid: process.pid,
      processStartToken,
      lastHeartbeatAt: Date.now(),
    });
  });

  // Pi rebuilds prompt options for each new run. Refresh our own section rather
  // than returning a full prompt that would mask other extensions' sections.
  pi.on("before_agent_start", async (event) => {
    if (isTeammate) {
      if (teamName) {
        await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
          lastHeartbeatAt: Date.now(),
        });
      }

      let member: Member | undefined;
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          member = teamConfig.members.find(m => m.name === agentName);
        } catch (e) {
          // Role guidance is still needed if the team config is unavailable.
        }
      }

      return applyTeamSystemPrompt(event, buildTeammateSystemPrompt({
        baseSystemPrompt: "",
        agentName,
        teamName,
        member,
      }));
    }

    return applyTeamSystemPrompt(event, buildLeadSystemPrompt({
      baseSystemPrompt: "",
      teamName,
    }));
  });

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    const runtimeStatus = await runtime.readRuntimeStatus(teamName, member.name);
    // Notify launch bridges before SIGKILL; otherwise they may exit as a crash
    // and Windows Terminal's graceful close-on-exit will retain the pane.
    if (member.windowId) terminal?.prepareShutdown?.(member.windowId);
    if (member.tmuxPaneId) terminal?.prepareShutdown?.(member.tmuxPaneId);
    if (runtimeStatus?.instanceId) {
      await runtime.replaceRuntimeInstance(teamName, member.name, runtimeStatus.instanceId, undefined, {
        activity: "stopped",
        lastHeartbeatAt: Date.now(),
      }).catch(() => undefined);
    } else {
      await runtime.setRuntimeActivity(teamName, member.name, "stopped", {
        lastHeartbeatAt: Date.now(),
      }).catch(() => undefined);
    }

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf-8").trim();
        const parsedPid = parseInt(pid, 10);
        if (
          runtimeStatus?.pid === parsedPid &&
          runtimeStatus.processStartToken !== undefined &&
          runtime.isRuntimeProcessAlive(runtimeStatus)
        ) {
          process.kill(parsedPid, "SIGKILL");
        }
        fs.unlinkSync(pidFile);
      } catch (e) {
        // ignore
      }
    }

    if (member.windowId && terminal) {
      terminal.killWindow(member.windowId);
    }

    if (member.tmuxPaneId && terminal) {
      terminal.kill(member.tmuxPaneId);
    }

  }

  function isMemberAlive(team: string, member: Member, runtimeStatus?: runtime.AgentRuntimeStatus | null): boolean {
    if (runtimeStatus?.pid !== undefined) {
      if (!runtime.isRuntimeProcessAlive(runtimeStatus)) return false;
      if (!runtimeStatus.processStartToken) {
        if (member.windowId && terminal) return terminal.isWindowAlive(member.windowId);
        if (member.tmuxPaneId && terminal) return terminal.isAlive(member.tmuxPaneId);
      }
      return true;
    }

    if (member.name === "team-lead") {
      try {
        const leadSession = JSON.parse(fs.readFileSync(paths.leadSessionPath(team), "utf-8"));
        if (typeof leadSession.pid === "number" && isPidAlive(leadSession.pid, leadSession.processStartToken)) {
          return true;
        }
      } catch {
        if (team === teamName && process.pid > 0) return true;
      }
      if (member.windowId && terminal) return terminal.isWindowAlive(member.windowId);
      if (member.tmuxPaneId && terminal) return terminal.isAlive(member.tmuxPaneId);
      return false;
    }

    if (member.windowId && terminal) return terminal.isWindowAlive(member.windowId);
    if (member.tmuxPaneId && terminal) return terminal.isAlive(member.tmuxPaneId);
    return false;
  }

  async function memberSnapshot(team: string, member: Member) {
    const runtimeStatus = await runtime.readRuntimeStatus(team, member.name);
    const unreadCount = (await messaging.readInbox(team, member.name, true, false)).length;
    const alive = isMemberAlive(team, member, runtimeStatus);
    const classified = classifyTeamWaitPeer({
      name: member.name,
      agentType: member.agentType,
      alive,
      activity: runtimeStatus?.activity,
      activityChangedAt: runtimeStatus?.activityChangedAt,
      joinedAt: member.joinedAt,
      unreadCount,
    }, Date.now(), runtime.STARTUP_STALL_MS);

    return {
      ...classified,
      liveness: alive ? "alive" as const : "dead" as const,
      model: member.model,
      thinking: member.thinking,
      runtime: runtimeStatus,
    };
  }

  /**
   * Resolve teammate model:
   * tool `model` → team.defaultModel → settings.json teammateDefaultModel → undefined
   * (undefined → bare `pi`, which falls back to leader Pi settings defaults)
   */
  function resolveChosenModel(
    teamConfig: any,
    model: string | undefined,
    settings: AgentSettings,
  ): string | undefined {
    let chosenModel = resolveTeammateModel({
      explicitModel: model,
      teamDefaultModel: teamConfig.defaultModel,
      settings,
    });

    if (chosenModel && !chosenModel.includes("/")) {
      const resolved = resolveModelWithProvider(chosenModel);
      if (resolved) {
        chosenModel = resolved;
      } else if (teamConfig.defaultModel && teamConfig.defaultModel.includes("/")) {
        const [provider] = teamConfig.defaultModel.split("/");
        chosenModel = `${provider}/${chosenModel}`;
      }
    }

    return chosenModel;
  }

  /**
   * Resolve teammate thinking:
   * tool `thinking` → settings.json teammateDefaultThinkingLevel → undefined
   */
  function resolveChosenThinking(
    thinking: string | undefined,
    settings: AgentSettings,
  ): Member["thinking"] {
    return resolveTeammateThinking({
      explicitThinking: thinking,
      settings,
    });
  }

  async function spawnTeammateProcess(
    safeTeamName: string,
    safeName: string,
    cwd: string,
    chosenModel: string | undefined,
    thinking: Member["thinking"],
    useSeparateWindow: boolean,
    teamConfig: any
  ): Promise<{ terminalId: string; isWindow: boolean }> {
    if (!terminal) {
      throw new Error("No terminal adapter detected.");
    }
    if (useSeparateWindow && !terminal.supportsWindows()) {
      throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
    }

    const piCmd = buildPiCommand(getPiLaunchCommand(), chosenModel, thinking);
    const env: Record<string, string> = {
      ...process.env,
      PI_TEAM_NAME: safeTeamName,
      PI_AGENT_NAME: safeName,
    };

    if (useSeparateWindow) {
      const terminalId = terminal.spawnWindow({
        name: safeName,
        cwd,
        command: piCmd,
        env,
        teamName: safeTeamName,
      });
      await teams.updateMember(safeTeamName, safeName, { windowId: terminalId });
      return { terminalId, isWindow: true };
    }

    if (terminal instanceof Iterm2Adapter) {
      const teammates = teamConfig.members.filter((m: Member) => m.agentType === "teammate" && m.tmuxPaneId.startsWith("iterm_"));
      const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
      terminal.setSpawnContext(lastTeammate?.tmuxPaneId
        ? { lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") }
        : {});
    }

    const leadMember = teamConfig.members.find((m: Member) => m.name === "team-lead");
    const anchorPaneId = terminal.name === "tmux"
      ? leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined
      : undefined;

    const terminalId = terminal.spawn({
      name: safeName,
      cwd,
      command: piCmd,
      env,
      anchorPaneId,
    });
    await teams.updateMember(safeTeamName, safeName, { tmuxPaneId: terminalId });
    return { terminalId, isWindow: false };
  }

  function delegatedTaskPrompt(task: any, prompt: string | undefined): string {
    return [
      `You have been assigned task ${task.id}: ${task.subject}`,
      "",
      task.description,
      prompt ? `\nAdditional instructions:\n${prompt}` : "",
    ].filter(Boolean).join("\n");
  }

  // Tools
  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a new agent team.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String()),
      separate_windows: Type.Optional(Type.Boolean({ default: false, description: "Open teammates in separate OS windows instead of panes" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (teamName) {
        throw new Error(`This lead session is already bound to team ${teamName}; shut it down before creating another team`);
      }
      // Auto-cleanup stale team if the previous lead process is dead
      // This handles the case where a session was aborted and restarted
      if (teams.teamExists(params.team_name)) {
        const cleaned = cleanupStaleTeam(params.team_name, terminal);
        if (!cleaned && teams.teamExists(params.team_name)) {
          throw new Error(`Team ${params.team_name} already exists and has an active or recoverable lead session`);
        }
      }
      
      const config = await teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, params.default_model, params.separate_windows);
      // Register this session as the lead so it can receive inbox messages
      registerLeadSession(params.team_name);
      // Update teamName and start inbox polling for the lead
      teamName = params.team_name;
      await runtime.setRuntimeActivity(params.team_name, agentName, "running", {
        instanceId: runtimeInstanceId,
        pid: process.pid,
        processStartToken,
        startedAt: Date.now(),
        activityChangedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      });
      startInboxPolling();
      return {
        content: [{ type: "text", text: `Team ${params.team_name} created.` }],
        details: { config },
      };
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Create a task, assign it to a teammate, and spawn or reuse that teammate as needed.",
    parameters: Type.Object({
      team_name: Type.String(),
      teammate_name: Type.String(),
      cwd: Type.String(),
      task_subject: Type.String(),
      task_description: Type.String(),
      prompt: Type.Optional(Type.String({ description: "Additional teammate instructions for this task." })),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum([...THINKING_LEVELS])),
      reuse: Type.Optional(StringEnum(["existing", "replace", "error"])),
      separate_window: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeName = paths.sanitizeName(params.teammate_name);
      const reuse = params.reuse ?? "existing";

      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }

      let teamConfig = await teams.readConfig(safeTeamName);
      let member = teamConfig.members.find(m => m.name === safeName && m.agentType === "teammate");
      const memberRuntime = member ? await runtime.readRuntimeStatus(safeTeamName, member.name) : null;
      const memberAlive = member ? isMemberAlive(safeTeamName, member, memberRuntime) : false;
      const willSpawn = !member || reuse === "replace" || !memberAlive;
      const requestedSeparateWindow = params.separate_window ?? teamConfig.separateWindows ?? false;

      if (member && reuse === "error") {
        throw new Error(`Teammate ${safeName} already exists in team ${safeTeamName}`);
      }

      if (member && memberAlive && reuse === "existing" && member.cwd && path.resolve(member.cwd) !== path.resolve(params.cwd)) {
        throw new Error(`Teammate ${safeName} is already running in ${member.cwd}. Use reuse="replace" to restart it in ${params.cwd}.`);
      }

      if (willSpawn) {
        if (!terminal) {
          throw new Error("No terminal adapter detected.");
        }
        if (requestedSeparateWindow && !terminal.supportsWindows()) {
          throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
        }
      }

      if (member && (reuse === "replace" || !memberAlive)) {
        await killTeammate(safeTeamName, member);
        await teams.removeMember(safeTeamName, safeName);
        member = undefined;
        teamConfig = await teams.readConfig(safeTeamName);
      }

      const task = await tasks.createTask(safeTeamName, params.task_subject, params.task_description, {
        metadata: { createdBy: "delegate_task" },
      });

      let terminalId = member?.windowId || member?.tmuxPaneId || "";
      let isWindow = !!member?.windowId;
      let spawned = false;
      let spawnConfig: {
        chosenModel?: string;
        chosenThinking?: Member["thinking"];
        useSeparateWindow: boolean;
      } | undefined;

      if (!member) {
        const settings = loadAgentSettings();
        const chosenModel = resolveChosenModel(teamConfig, params.model, settings);
        const chosenThinking = resolveChosenThinking(params.thinking, settings);
        const newMember: Member = {
          agentId: `${safeName}@${safeTeamName}`,
          name: safeName,
          agentType: "teammate",
          model: chosenModel,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd: params.cwd,
          subscriptions: [],
          prompt: delegatedTaskPrompt(task, params.prompt),
          color: "blue",
          thinking: chosenThinking,
        };

        try {
          await teams.addMember(safeTeamName, newMember);
          await runtime.setRuntimeActivity(safeTeamName, safeName, "starting", {
            instanceId: undefined,
            pid: undefined,
            processStartToken: undefined,
            startedAt: newMember.joinedAt,
            activityChangedAt: newMember.joinedAt,
            lastHeartbeatAt: newMember.joinedAt,
            lastError: undefined,
          });
          member = newMember;
          spawnConfig = {
            chosenModel,
            chosenThinking,
            useSeparateWindow: requestedSeparateWindow,
          };
        } catch (error) {
          // Another delegate call may have reserved this name after our initial
          // config snapshot. Reuse that member rather than spawning a duplicate.
          const latestConfig = await teams.readConfig(safeTeamName);
          const existing = latestConfig.members.find(candidate =>
            candidate.name === safeName && candidate.agentType === "teammate");
          if (!existing) throw error;
          member = existing;
          teamConfig = latestConfig;
        }
      }

      const assigned = await tasks.assignTask(safeTeamName, task.id, safeName, {
        assignedBy: agentName,
        notifyOwner: false,
        status: "in_progress",
      });

      await messaging.sendPlainMessage(
        safeTeamName,
        agentName,
        safeName,
        delegatedTaskPrompt(assigned, params.prompt),
        `Task ${task.id} delegated to you`
      );

      if (spawnConfig) {
        try {
          const spawnResult = await spawnTeammateProcess(
            safeTeamName,
            safeName,
            params.cwd,
            spawnConfig.chosenModel,
            spawnConfig.chosenThinking,
            spawnConfig.useSeparateWindow,
            teamConfig
          );
          terminalId = spawnResult.terminalId;
          isWindow = spawnResult.isWindow;
          spawned = true;
        } catch (error) {
          await teams.removeMember(safeTeamName, safeName);
          const inbox = paths.inboxPath(safeTeamName, safeName);
          if (fs.existsSync(inbox)) fs.unlinkSync(inbox);
          await tasks.updateTask(safeTeamName, task.id, {
            owner: undefined,
            status: "pending",
            metadata: {
              ...(assigned.metadata ?? {}),
              delegationError: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        }
      }

      return {
        content: [{
          type: "text",
          text: `Task ${task.id} delegated to ${safeName}${spawned ? ` in ${isWindow ? "window" : "pane"} ${terminalId}` : ""}.`,
        }],
        details: { task: assigned, teammate: member, spawned, terminalId, isWindow },
      };
    },
  });

  pi.registerTool({
    name: "spawn_lead_window",
    label: "Spawn Lead Window",
    description: "Move the team lead to a separate OS window. The current lead session exits after the handoff so only one lead consumes the inbox.",
    parameters: Type.Object({
      team_name: Type.String(),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      if (isTeammate || agentName !== "team-lead" || teamName !== safeTeamName) {
        throw new Error("spawn_lead_window must be called by the lead session currently bound to this team");
      }
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      if (!terminal || !terminal.supportsWindows()) throw new Error("Windows mode not supported.");

      const teamConfig = await teams.readConfig(safeTeamName);
      const cwd = params.cwd || process.cwd();
      const piCmd = buildPiCommand(getPiLaunchCommand(), teamConfig.defaultModel);

      const handoffToken = randomUUID();
      const handoffStartedAt = Date.now();
      const placeholder = await runtime.replaceRuntimeInstance(
        safeTeamName,
        agentName,
        runtimeInstanceId,
        handoffToken,
        {
          activity: "starting",
          pid: undefined,
          processStartToken: undefined,
          startedAt: handoffStartedAt,
          activityChangedAt: handoffStartedAt,
          lastHeartbeatAt: handoffStartedAt,
          lastError: undefined,
        },
        ["starting", "queued", "running", "idle"],
      );
      if (!placeholder) {
        throw new Error("This lead session no longer owns the active runtime lease");
      }
      stopInboxPolling();

      const env = {
        ...process.env,
        PI_TEAM_NAME: safeTeamName,
        PI_AGENT_NAME: "team-lead",
        PI_TEAM_HANDOFF_TOKEN: handoffToken,
      };
      try {
        const windowId = terminal.spawnWindow({ name: "team-lead", cwd, command: piCmd, env, teamName: safeTeamName });
        await teams.updateMember(safeTeamName, "team-lead", { windowId });
        teamName = null;
        ctx.ui.setStatus("pi-teams", undefined);
        setTimeout(() => ctx.shutdown(), 250);
        return {
          content: [{ type: "text", text: `Lead moved to window ${windowId}; this lead session is shutting down.` }],
          details: { windowId, handoff: true },
        };
      } catch (e) {
        const restored = await runtime.replaceRuntimeInstance(
          safeTeamName,
          agentName,
          handoffToken,
          runtimeInstanceId,
          {
            activity: "running",
            pid: process.pid,
            processStartToken,
            startedAt: Date.now(),
            activityChangedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            lastError: runtime.createRuntimeError(e),
          },
          "starting",
        ).catch(() => null);
        if (restored) {
          startInboxPolling();
        } else {
          teamName = null;
          ctx.ui.setStatus("pi-teams", undefined);
          setTimeout(() => ctx.shutdown(), 0);
        }
        throw new Error(`Failed: ${e}`);
      }
    }
  });

  pi.registerTool({
    name: "team_message",
    label: "Team Message",
    description: "Send a message to one teammate, the lead, or everyone on the team.",
    parameters: Type.Object({
      team_name: Type.String(),
      to: Type.String({ description: "Recipient name, 'team-lead', or 'all'." }),
      content: Type.String(),
      summary: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const summary = params.summary || params.content.split("\n")[0].slice(0, 80);
      if (params.to === "all") {
        await messaging.broadcastMessage(params.team_name, agentName, params.content, summary, params.color);
        return {
          content: [{ type: "text", text: "Message sent to all team members." }],
          details: { to: "all" },
        };
      }

      const config = await teams.readConfig(params.team_name);
      if (!config.members.some(m => m.name === params.to)) {
        throw new Error(`Agent ${params.to} is not a member of team ${params.team_name}`);
      }

      await messaging.sendPlainMessage(params.team_name, agentName, params.to, params.content, summary, params.color);
      return {
        content: [{ type: "text", text: `Message sent to ${params.to}.` }],
        details: { to: params.to },
      };
    },
  });

  pi.registerTool({
    name: "team_wait",
    label: "Team Wait",
    description: "Block until this member receives a team message, no other member can make progress, an optional timeout expires, or the call is aborted. The default is an indefinite wait.",
    executionMode: "sequential",
    parameters: Type.Object({
      team_name: Type.String(),
      timeout_seconds: Type.Optional(Type.Number({
        minimum: 0.001,
        description: "Optional positive timeout in seconds. Omit to wait indefinitely.",
      })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teamName || safeTeamName !== teamName) {
        throw new Error(`This Pi session is bound to team ${teamName ?? "none"}, not ${safeTeamName}`);
      }
      if (params.timeout_seconds !== undefined && (
        !Number.isFinite(params.timeout_seconds) || params.timeout_seconds <= 0
      )) {
        throw new Error("timeout_seconds must be a positive finite number when provided");
      }

      const initialConfig = await teams.readConfig(safeTeamName);
      if (!initialConfig.members.some(member => member.name === agentName)) {
        throw new Error(`Agent ${agentName} is not a member of team ${safeTeamName}`);
      }

      const enteredWait = await runtime.updateRuntimeStatusForInstance(safeTeamName, agentName, runtimeInstanceId, {
        activity: "waiting",
        pid: process.pid,
        processStartToken,
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      }, "running");
      if (!enteredWait) {
        throw new Error(`Agent ${agentName} no longer owns the active runtime lease for team ${safeTeamName}`);
      }

      try {
        const result = await waitForTeam({
          timeoutSeconds: params.timeout_seconds,
          signal,
          consumeMessages: async () => {
            const lease = await runtime.updateRuntimeStatusForInstance(
              safeTeamName,
              agentName,
              runtimeInstanceId,
              { lastHeartbeatAt: Date.now() },
              "waiting",
            );
            if (!lease) throw new Error(`Agent ${agentName} lost its runtime lease while waiting`);

            const messages = await messaging.readInbox(safeTeamName, agentName, true, false);
            if (messages.length > 0) {
              const leaseAfterRead = await runtime.updateRuntimeStatusForInstance(
                safeTeamName,
                agentName,
                runtimeInstanceId,
                { lastInboxReadAt: Date.now(), lastHeartbeatAt: Date.now() },
                "waiting",
              );
              if (!leaseAfterRead) throw new Error(`Agent ${agentName} lost its runtime lease before inbox delivery`);

              // A team_wait result is the delivery channel. Once this session
              // owns the lease and returns the messages, acknowledge them now
              // instead of waiting for an unrelated future settled event.
              await messaging.markMessagesRead(safeTeamName, agentName, messages.map(message => message.id));
            }
            return messages;
          },
          getPeers: async () => {
            const config = await teams.readConfig(safeTeamName);
            if (!config.members.some(member => member.name === agentName)) {
              throw new Error(`Agent ${agentName} is no longer a member of team ${safeTeamName}`);
            }
            return Promise.all(config.members
              .filter(member => member.name !== agentName)
              .map(async member => {
                const status = await runtime.readRuntimeStatus(safeTeamName, member.name);
                return {
                  name: member.name,
                  agentType: member.agentType,
                  alive: isMemberAlive(safeTeamName, member, status),
                  activity: status?.activity,
                  activityChangedAt: status?.activityChangedAt,
                  joinedAt: member.joinedAt,
                  unreadCount: (await messaging.readInbox(safeTeamName, member.name, true, false)).length,
                };
              }));
          },
          onPoll: async () => {
            const lease = await runtime.updateRuntimeStatusForInstance(
              safeTeamName,
              agentName,
              runtimeInstanceId,
              { lastHeartbeatAt: Date.now() },
              "waiting",
            );
            if (!lease) throw new Error(`Agent ${agentName} lost its runtime lease while waiting`);
          },
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } finally {
        await runtime.updateRuntimeStatusForInstance(safeTeamName, agentName, runtimeInstanceId, {
          activity: "running",
          pid: process.pid,
          processStartToken,
          lastHeartbeatAt: Date.now(),
        }, "waiting").catch(() => undefined);
      }
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "List all tasks for a team.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const taskList = await tasks.listTasks(params.team_name);
      return {
        content: [{ type: "text", text: JSON.stringify(taskList, null, 2) }],
        details: { tasks: taskList },
      };
    },
  });

  pi.registerTool({
    name: "task_claim",
    label: "Claim Task",
    description: "Claim an unassigned task for the current agent using task locking.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const task = await tasks.claimTask(params.team_name, params.task_id, {
        claimedBy: agentName,
      });
      return {
        content: [{ type: "text", text: `Task ${params.task_id} claimed.` }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "task_complete",
    label: "Complete Task",
    description: "Mark the current agent's task complete, running completion hooks before the status changes.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      summary: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const task = await tasks.completeTask(params.team_name, params.task_id, {
        completedBy: agentName,
        summary: params.summary,
      });
      return {
        content: [{ type: "text", text: `Task ${params.task_id} completed.` }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "team_shutdown",
    label: "Shutdown Team",
    description: "Shutdown the entire team and close all panes/windows.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (isTeammate) throw new Error("Only the team lead can shut down an entire team");
      const shuttingDownTeamName = params.team_name;
      try {
        const config = await teams.readConfig(shuttingDownTeamName);
        if (teamName === shuttingDownTeamName) {
          await runtime.updateRuntimeStatusForInstance(shuttingDownTeamName, agentName, runtimeInstanceId, {
            activity: "stopped",
            lastHeartbeatAt: Date.now(),
          }).catch(() => undefined);
        }
        for (const member of config.members) {
          await killTeammate(shuttingDownTeamName, member);
        }
        if (teamName === shuttingDownTeamName) {
          stopInboxPolling();
          teamName = null;
          ctx.ui.setStatus("pi-teams", undefined);
        }
        const dir = paths.teamDir(shuttingDownTeamName);
        const tasksDir = paths.taskDir(shuttingDownTeamName);
        if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true });
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

        // Clean up orphaned agent session folders (older than 1 hour)
        const cleanedSessions = cleanupAgentSessionFolders(60 * 60 * 1000);

        return {
          content: [{
            type: "text",
            text: `Team ${shuttingDownTeamName} shut down.${cleanedSessions > 0 ? ` Cleaned up ${cleanedSessions} orphaned agent session folder(s).` : ""}`
          }],
          details: { cleanedSessions }
        };
      } catch (e) {
        throw new Error(`Failed to shutdown team: ${e}`);
      }
    },
  });

  pi.registerTool({
    name: "cleanup_agent_sessions",
    label: "Cleanup Agent Sessions",
    description: "Clean up orphaned agent session folders from ~/.pi/agent/teams/ that are older than a specified age.",
    parameters: Type.Object({
      max_age_hours: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const maxAgeHours = params.max_age_hours ?? 24;
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
      const cleaned = cleanupAgentSessionFolders(maxAgeMs);
      return {
        content: [{
          type: "text",
          text: `Cleaned up ${cleaned} orphaned agent session folder(s) older than ${maxAgeHours} hour(s).`
        }],
        details: { cleaned, maxAgeHours }
      };
    },
  });

  pi.registerTool({
    name: "task_read",
    label: "Read Task",
    description: "Read details of a specific task.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const task = await tasks.readTask(params.team_name, params.task_id);
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "check_teammate",
    label: "Check Teammate",
    description: "Check a single teammate's status.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

      const details = await memberSnapshot(params.team_name, member);

      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "team_status",
    label: "Team Status",
    description: "Show team members, task board, and runtime health in one response.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const taskList = await tasks.listTasks(params.team_name);
      const members = await Promise.all(config.members.map(member => memberSnapshot(params.team_name, member)));

      const result = { team: config.name, members, tasks: taskList };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "process_shutdown_approved",
    label: "Process Shutdown Approved",
    description: "Process a teammate's shutdown.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

      await killTeammate(params.team_name, member);
      await teams.removeMember(params.team_name, params.agent_name);
      return {
        content: [{ type: "text", text: `Teammate ${params.agent_name} has been shut down.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_predefined_teams",
    label: "List Predefined Teams",
    description: "List all available predefined team configurations from teams.yaml files. These are team templates that can be instantiated with create_predefined_team.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const predefinedTeams = predefined.getAllPredefinedTeams(projectDir);
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = predefinedTeams.map(team => {
        const teamAgents = team.agents.map(agentName => {
          const agentDef = agents.find(a => a.name === agentName);
          return {
            name: agentName,
            description: agentDef?.description || "(agent definition not found)",
            found: !!agentDef,
          };
        });
        
        return {
          name: team.name,
          agents: teamAgents,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { teams: result },
      };
    },
  });

  pi.registerTool({
    name: "list_predefined_agents",
    label: "List Predefined Agents",
    description: "List all available predefined agent definitions from .md files. These can be used individually or as part of predefined teams.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = agents.map(agent => ({
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        thinking: agent.thinking,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { agents: result },
      };
    },
  });

  pi.registerTool({
    name: "create_predefined_team",
    label: "Create Predefined Team",
    description: "Create a team from a predefined team configuration. Spawns all agents defined in the team template from teams.yaml. Each agent is spawned with its predefined prompt, tools, and settings.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team instance" }),
      predefined_team: Type.String({ description: "Name of the predefined team template from teams.yaml" }),
      cwd: Type.String({ description: "Working directory for spawned agents" }),
      default_model: Type.Optional(Type.String({ description: "Default model for agents without a specified model" })),
      separate_windows: Type.Optional(Type.Boolean({ default: false, description: "Open teammates in separate OS windows instead of panes" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (teamName) {
        throw new Error(`This lead session is already bound to team ${teamName}; shut it down before creating another team`);
      }
      const projectDir = ctx.cwd;
      const predefinedTeam = predefined.getPredefinedTeam(params.predefined_team, projectDir);
      
      if (!predefinedTeam) {
        const available = predefined.getAllPredefinedTeams(projectDir).map(t => t.name);
        throw new Error(`Predefined team "${params.predefined_team}" not found. Available teams: ${available.join(", ") || "none"}`);
      }

      if (!terminal) {
        throw new Error("No terminal adapter detected.");
      }

      // Create the team
      const config = await teams.createTeam(params.team_name, "local-session", "lead-agent", `Predefined team: ${params.predefined_team}`, params.default_model, params.separate_windows);
      registerLeadSession(params.team_name);
      // Update teamName and start inbox polling for the lead
      teamName = params.team_name;
      await runtime.setRuntimeActivity(params.team_name, agentName, "running", {
        instanceId: runtimeInstanceId,
        pid: process.pid,
        processStartToken,
        startedAt: Date.now(),
        activityChangedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      });
      startInboxPolling();

      const agentDefinitions = predefined.getAllAgentDefinitions(projectDir);
      const spawnResults: Array<{ name: string; status: string; error?: string }> = [];
      const settings = loadAgentSettings();

      // Spawn each agent in the predefined team
      for (const agentName of predefinedTeam.agents) {
        const agentDef = agentDefinitions.find(a => a.name === agentName);
        
        if (!agentDef) {
          spawnResults.push({ name: agentName, status: "skipped", error: "Agent definition not found" });
          continue;
        }

        try {
          const safeName = paths.sanitizeName(agentName);
          const safeTeamName = paths.sanitizeName(params.team_name);
          
          let chosenModel = resolveTeammateModel({
            explicitModel: agentDef.model || params.default_model,
            teamDefaultModel: config.defaultModel,
            settings,
          });

          if (chosenModel && !chosenModel.includes("/")) {
            const resolved = resolveModelWithProvider(chosenModel);
            if (resolved) {
              chosenModel = resolved;
            } else if (config.defaultModel && config.defaultModel.includes("/")) {
              const [provider] = config.defaultModel.split("/");
              chosenModel = `${provider}/${chosenModel}`;
            }
          }

          const chosenThinking = resolveTeammateThinking({
            explicitThinking: agentDef.thinking,
            settings,
          });

          const useSeparateWindow = params.separate_windows ?? config.separateWindows ?? false;
          if (useSeparateWindow && !terminal.supportsWindows()) {
            throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
          }

          const member: Member = {
            agentId: `${safeName}@${safeTeamName}`,
            name: safeName,
            agentType: "teammate",
            model: chosenModel,
            joinedAt: Date.now(),
            tmuxPaneId: "",
            cwd: params.cwd,
            subscriptions: [],
            prompt: agentDef.prompt,
            color: "blue",
            thinking: chosenThinking,
          };

          await teams.addMember(safeTeamName, member);
          await runtime.setRuntimeActivity(safeTeamName, safeName, "starting", {
            instanceId: undefined,
            pid: undefined,
            processStartToken: undefined,
            startedAt: member.joinedAt,
            activityChangedAt: member.joinedAt,
            lastHeartbeatAt: member.joinedAt,
            lastError: undefined,
          });
          await messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, agentDef.prompt, "Initial prompt from predefined team");

          const piCmd = buildPiCommand(getPiLaunchCommand(), chosenModel, chosenThinking);

          const env: Record<string, string> = {
            ...process.env,
            PI_TEAM_NAME: safeTeamName,
            PI_AGENT_NAME: safeName,
          };

          let terminalId = "";
          let isWindow = false;

          try {
            if (useSeparateWindow) {
              isWindow = true;
              terminalId = terminal.spawnWindow({
                name: safeName,
                cwd: params.cwd,
                command: piCmd,
                env: env,
                teamName: safeTeamName,
              });
              await teams.updateMember(safeTeamName, safeName, { windowId: terminalId });
            } else {
              if (terminal instanceof Iterm2Adapter) {
                const teammates = (await teams.readConfig(safeTeamName)).members.filter(m => m.agentType === "teammate" && m.tmuxPaneId.startsWith("iterm_"));
                const lastTeammate = teammates.length > 0 ? teammates[teammates.length - 1] : null;
                if (lastTeammate?.tmuxPaneId) {
                  terminal.setSpawnContext({ lastSessionId: lastTeammate.tmuxPaneId.replace("iterm_", "") });
                } else {
                  terminal.setSpawnContext({});
                }
              }

              const leadMember = (await teams.readConfig(safeTeamName)).members.find(m => m.name === "team-lead");
              const anchorPaneId = terminal.name === "tmux"
                ? leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined
                : undefined;

              terminalId = terminal.spawn({
                name: safeName,
                cwd: params.cwd,
                command: piCmd,
                env: env,
                anchorPaneId,
              });
              await teams.updateMember(safeTeamName, safeName, { tmuxPaneId: terminalId });
            }

            spawnResults.push({ name: agentName, status: "spawned", error: undefined });
          } catch (e) {
            spawnResults.push({ name: agentName, status: "error", error: `Failed to spawn: ${e}` });
          }
        } catch (e) {
          spawnResults.push({ name: agentName, status: "error", error: String(e) });
        }
      }

      const summary = spawnResults.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
      
      return {
        content: [{ type: "text", text: `Team "${params.team_name}" created from predefined team "${params.predefined_team}".\n\nAgent spawn results:\n${summary}` }],
        details: { teamName: params.team_name, predefinedTeam: params.predefined_team, results: spawnResults },
      };
    },
  });

  pi.registerTool({
    name: "save_team_as_template",
    label: "Save Team as Template",
    description: "Save a runtime team as a reusable predefined team template. Creates agent definition files and updates teams.yaml. Use this when you've created a team with custom prompts and want to reuse it later.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name of the runtime team to save" }),
      template_name: Type.String({ description: "Name for the template (e.g., 'modularization', 'frontend-team')" }),
      description: Type.Optional(Type.String({ description: "Description for the template" })),
      scope: Type.Optional(StringEnum(["user", "project"], { description: "Where to save: 'user' for global (~/.pi), 'project' for project-local (.pi). Defaults to 'user'." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const teamName = params.team_name;
      
      // Verify the team exists
      if (!teams.teamExists(teamName)) {
        throw new Error(`Team "${teamName}" does not exist. Use list_runtime_teams to see available teams.`);
      }

      // Read the team configuration
      const config = await teams.readConfig(teamName);
      
      // Check that there are teammates to save
      const teammates = config.members.filter(m => m.agentType === "teammate");
      if (teammates.length === 0) {
        throw new Error(`Team "${teamName}" has no teammates to save. Only teams with spawned teammates can be saved as templates.`);
      }

      // Save the team as a template
      const result = predefined.saveTeamTemplate(config, {
        templateName: params.template_name,
        description: params.description,
        scope: params.scope || "user",
        projectDir: ctx.cwd,
      });

      // Build summary message
      const agentSummary = result.savedAgents.map(a => 
        `  - ${a.name}: ${a.existed ? "updated" : "created"} at ${a.path}`
      ).join("\n");
      
      const message = `Team "${teamName}" saved as template "${params.template_name}".

Agents saved:
${agentSummary}

Template location: ${result.teamsYamlPath}

You can now use this template with:
  create_predefined_team({ team_name: "new-team", predefined_team: "${params.template_name}", cwd: "..." })`;

      return {
        content: [{ type: "text", text: message }],
        details: {
          teamName,
          templateName: params.template_name,
          agentsDir: result.agentsDir,
          teamsYamlPath: result.teamsYamlPath,
          savedAgents: result.savedAgents,
          templateExisted: result.templateExisted,
        },
      };
    },
  });

  pi.registerTool({
    name: "list_runtime_teams",
    label: "List Runtime Teams",
    description: "List all runtime team configurations that can be saved as templates. These are active or saved teams from ~/.pi/teams/.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const runtimeTeams = predefined.listRuntimeTeams();
      
      if (runtimeTeams.length === 0) {
        return {
          content: [{ type: "text", text: "No runtime teams found. Create a team with team_create first." }],
          details: { teams: [] },
        };
      }

      const result = runtimeTeams.map(team => ({
        name: team.name,
        description: team.description,
        memberCount: team.memberCount,
        createdAt: team.createdAt ? new Date(team.createdAt).toISOString() : undefined,
      }));

      const summary = result.map(t => 
        `- ${t.name}: ${t.memberCount} teammate(s)${t.description ? ` - ${t.description}` : ""}`
      ).join("\n");

      return {
        content: [{ type: "text", text: `Runtime teams:\n${summary}` }],
        details: { teams: result },
      };
    },
  });
}
