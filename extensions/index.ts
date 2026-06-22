import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import { buildTeammateSystemPrompt } from "../src/utils/plan-mode-prompt";
import { Member } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import * as predefined from "../src/utils/predefined-teams";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Build the command used to relaunch pi for teammate processes.
 *
 * There are three common cases:
 * - npm/node install: pi runs as `node .../dist/cli.js`
 * - standalone compiled binary: process.execPath is the actual `pi` executable
 * - shim-based installs (e.g. Volta): process.execPath is `node` and argv[1]
 *   may be a shim path, so the safest relaunch command is plain `pi`
 */
function getPiLaunchCommand(): string {
  const argv1 = process.argv[1];
  const execPath = process.execPath;

  // Regular Node install: relaunch the actual CLI script with node.
  if (argv1) {
    const ext = path.extname(argv1).toLowerCase();
    const looksLikeScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(ext)
      || /(?:^|[/\\])dist[/\\]cli\.js$/i.test(argv1);

    if (looksLikeScript) {
      return `node ${JSON.stringify(argv1)}`;
    }
  }

  // Standalone binary install: execPath is the pi executable itself.
  if (execPath) {
    const base = path.basename(execPath).toLowerCase();
    if (base !== "node" && base !== "node.exe" && base !== "bun" && base !== "bun.exe") {
      return JSON.stringify(execPath);
    }
  }

  // Shim-based installs (like Volta) are safest to relaunch through PATH.
  return "pi";
}

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
          if (session.pid === process.pid) {
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
  fs.writeFileSync(sessionFile, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }));
}

/**
 * Check if a process with the given PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
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
    if (session.pid && !isPidAlive(session.pid)) {
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
              const pid = fs.readFileSync(pidFile, "utf-8").trim();
              process.kill(parseInt(pid), "SIGKILL");
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
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || findLeadTeamForSession();
  let teamName = detectedTeamName;

  const terminal = getTerminalAdapter();

  // Track whether lead inbox polling has been started (to avoid duplicates)
  let leadPollingStarted = false;
  let sessionCtx: any = null;

  /**
   * Start inbox polling for the team lead.
   * Called when a team is created or when the lead reconnects to an existing team.
   * Requires sessionCtx to be set (from session_start).
   */
  function startLeadInboxPolling() {
    if (leadPollingStarted || isTeammate || !sessionCtx) return;
    leadPollingStarted = true;

    setInterval(async () => {
      if (!teamName) return;
      if (sessionCtx.isIdle()) {
        try {
          const unread = await messaging.readInbox(teamName, agentName, true, false);
          if (unread.length > 0) {
            pi.sendUserMessage(`I have ${unread.length} new message(s) in my inbox. Reading them now...`);
          }
        } catch {
          // Ignore errors for lead polling
        }
      }
    }, 30000);
  }

  pi.on("session_start", async (_event, ctx) => {
    paths.ensureDirs();
    sessionCtx = ctx;

    if (isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
        fs.writeFileSync(pidFile, process.pid.toString());
        await runtime.writeRuntimeStatus(teamName, agentName, {
          pid: process.pid,
          startedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          ready: false,
          lastError: undefined,
        });
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

      setTimeout(() => {
        pi.sendUserMessage(`I am starting my work as '${agentName}' on team '${teamName}'. Checking my inbox for instructions...`);
      }, 1000);

      // Inbox polling for teammates
      if (teamName) {
        setInterval(async () => {
          if (ctx.isIdle()) {
            try {
              const unread = await messaging.readInbox(teamName!, agentName, true, false);
              await runtime.writeRuntimeStatus(teamName!, agentName, {
                lastHeartbeatAt: Date.now(),
              });
              if (unread.length > 0) {
                pi.sendUserMessage(`I have ${unread.length} new message(s) in my inbox. Reading them now...`);
              }
            } catch (e) {
              await runtime.writeRuntimeStatus(teamName!, agentName, {
                lastHeartbeatAt: Date.now(),
                lastError: runtime.createRuntimeError(e),
              });
            }
          }
        }, 30000);
      }
    } else if (teamName) {
      // Lead reconnecting to an existing team
      ctx.ui.setStatus("pi-teams", `Lead @ ${teamName}`);
      startLeadInboxPolling();
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
      if (terminal) terminal.setTitle(fullTitle);
      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, agentName, {
          lastHeartbeatAt: Date.now(),
        });
      }
    }
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    if (isTeammate && firstTurn) {
      firstTurn = false;

      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, agentName, {
          lastHeartbeatAt: Date.now(),
        });
      }

      let member: Member | undefined;
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          member = teamConfig.members.find(m => m.name === agentName);
        } catch (e) {
          // Ignore
        }
      }

      return {
        systemPrompt: buildTeammateSystemPrompt({
          baseSystemPrompt: event.systemPrompt,
          agentName,
          teamName,
          member,
        }),
      };
    }
  });

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf-8").trim();
        process.kill(parseInt(pid), "SIGKILL");
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

    await runtime.deleteRuntimeStatus(teamName, member.name);
  }

  function isMemberAlive(member: Member): boolean {
    if (!terminal) return false;
    if (member.windowId) return terminal.isWindowAlive(member.windowId);
    if (member.tmuxPaneId) return terminal.isAlive(member.tmuxPaneId);
    return false;
  }

  function resolveChosenModel(teamConfig: any, model?: string): string | undefined {
    let chosenModel = model || teamConfig.defaultModel;

    if (chosenModel && !chosenModel.includes('/')) {
      const resolved = resolveModelWithProvider(chosenModel);
      if (resolved) {
        chosenModel = resolved;
      } else if (teamConfig.defaultModel && teamConfig.defaultModel.includes('/')) {
        const [provider] = teamConfig.defaultModel.split('/');
        chosenModel = `${provider}/${chosenModel}`;
      }
    }

    return chosenModel;
  }

  function buildPiCommand(model?: string, thinking?: string): string {
    const piBinary = getPiLaunchCommand();
    if (model) {
      return thinking ? `${piBinary} --model ${model}:${thinking}` : `${piBinary} --model ${model}`;
    }
    return thinking ? `${piBinary} --thinking ${thinking}` : piBinary;
  }

  async function spawnTeammateProcess(
    safeTeamName: string,
    safeName: string,
    cwd: string,
    chosenModel: string | undefined,
    thinking: any,
    useSeparateWindow: boolean,
    teamConfig: any
  ): Promise<{ terminalId: string; isWindow: boolean }> {
    if (!terminal) {
      throw new Error("No terminal adapter detected.");
    }
    if (useSeparateWindow && !terminal.supportsWindows()) {
      throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
    }

    const piCmd = buildPiCommand(chosenModel, thinking);
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

  function delegatedTaskPrompt(task: any, prompt: string | undefined, planRequired: boolean): string {
    return [
      `You have been assigned task ${task.id}: ${task.subject}`,
      "",
      task.description,
      planRequired
        ? `\nThis task requires plan approval. Before editing files or executing implementation, call plan_submit with task_id="${task.id}" and wait for approval.`
        : "",
      prompt ? `\nAdditional instructions:\n${prompt}` : "",
    ].filter(Boolean).join("\n");
  }

  async function waitForTaskEvent(
    teamName: string,
    event: "plan" | "task_completed" | "all_tasks_done",
    options: {
      taskId?: string;
      pollIntervalMs?: number;
      timeoutSeconds?: number;
      signal?: AbortSignal;
      onPoll?: () => void | Promise<void>;
    } = {}
  ) {
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
    const timeoutMs = options.timeoutSeconds === undefined
      ? undefined
      : Math.max(0, options.timeoutSeconds * 1000);
    const startedAt = Date.now();

    const createAbortError = () => {
      const error = new Error("team_wait aborted");
      error.name = "AbortError";
      return error;
    };

    const delay = (ms: number) => new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      let timeout: ReturnType<typeof setTimeout>;
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        clearTimeout(timeout);
        cleanup();
        reject(createAbortError());
      };
      timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });

    while (true) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }

      const waitedMs = Date.now() - startedAt;
      const taskList = options.taskId
        ? [await tasks.readTask(teamName, options.taskId)]
        : await tasks.listTasks(teamName);

      if (event === "all_tasks_done" && !options.taskId && taskList.length === 0) {
        throw new Error(`No tasks to wait for in team ${teamName}.`);
      }

      const matchedTasks = event === "plan"
        ? taskList.filter(task => task.status === "planning" && task.plan?.trim() && !task.planFeedback?.trim())
        : event === "task_completed"
          ? taskList.filter(task => task.status === "completed")
          : taskList.length > 0 && taskList.every(task => task.status === "completed")
            ? taskList
            : [];

      if (matchedTasks.length > 0) {
        return { event, tasks: matchedTasks, waitedMs, timedOut: false };
      }

      if (timeoutMs !== undefined && waitedMs >= timeoutMs) {
        return { event, tasks: [], waitedMs, timedOut: true };
      }

      await options.onPoll?.();
      const remainingTimeoutMs = timeoutMs === undefined ? pollIntervalMs : timeoutMs - waitedMs;
      await delay(Math.min(pollIntervalMs, Math.max(1, remainingTimeoutMs)));
    }
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
      // Auto-cleanup stale team if the previous lead process is dead
      // This handles the case where a session was aborted and restarted
      if (teams.teamExists(params.team_name)) {
        cleanupStaleTeam(params.team_name, terminal);
      }
      
      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, params.default_model, params.separate_windows);
      // Register this session as the lead so it can receive inbox messages
      registerLeadSession(params.team_name);
      // Update teamName and start inbox polling for the lead
      teamName = params.team_name;
      startLeadInboxPolling();
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
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      plan_required: Type.Optional(Type.Boolean({ default: false })),
      reuse: Type.Optional(StringEnum(["existing", "replace", "error"])),
      wait: Type.Optional(StringEnum(["none", "plan", "completion"])),
      timeout_seconds: Type.Optional(Type.Number({ description: "Optional timeout when wait is plan or completion." })),
      separate_window: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeName = paths.sanitizeName(params.teammate_name);
      const reuse = params.reuse ?? "existing";
      const waitMode = params.wait ?? "none";

      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }

      let teamConfig = await teams.readConfig(safeTeamName);
      let member = teamConfig.members.find(m => m.name === safeName && m.agentType === "teammate");
      const memberAlive = member ? isMemberAlive(member) : false;
      const memberDefaultPlanRequired = member?.defaultPlanRequired ?? member?.planModeRequired ?? false;
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

      const planRequired = params.plan_required ?? memberDefaultPlanRequired;
      const task = await tasks.createTask(safeTeamName, params.task_subject, params.task_description, {
        planRequired,
        metadata: { createdBy: "delegate_task" },
      });

      let terminalId = member?.windowId || member?.tmuxPaneId || "";
      let isWindow = !!member?.windowId;
      let spawned = false;
      let spawnConfig: { chosenModel?: string; useSeparateWindow: boolean } | undefined;

      if (!member) {
        const chosenModel = resolveChosenModel(teamConfig, params.model);
        const newMember: Member = {
          agentId: `${safeName}@${safeTeamName}`,
          name: safeName,
          agentType: "teammate",
          model: chosenModel,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd: params.cwd,
          subscriptions: [],
          prompt: delegatedTaskPrompt(task, params.prompt, planRequired),
          color: "blue",
          thinking: params.thinking,
          defaultPlanRequired: false,
          planModeRequired: false,
        };

        await teams.addMember(safeTeamName, newMember);
        member = newMember;
        spawnConfig = { chosenModel, useSeparateWindow: requestedSeparateWindow };
      }

      const assigned = await tasks.assignTask(safeTeamName, task.id, safeName, {
        assignedBy: agentName,
        notifyOwner: false,
        status: planRequired ? "pending" : "in_progress",
        planRequired,
      });

      await messaging.sendPlainMessage(
        safeTeamName,
        agentName,
        safeName,
        delegatedTaskPrompt(assigned, params.prompt, planRequired),
        `Task ${task.id} delegated to you`
      );

      if (spawnConfig) {
        try {
          const spawnResult = await spawnTeammateProcess(
            safeTeamName,
            safeName,
            params.cwd,
            spawnConfig.chosenModel,
            params.thinking,
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

      let waitResult: any = undefined;
      if (waitMode === "plan") {
        waitResult = await waitForTaskEvent(safeTeamName, "plan", {
          taskId: task.id,
          timeoutSeconds: params.timeout_seconds,
          signal,
        });
      } else if (waitMode === "completion") {
        waitResult = await waitForTaskEvent(safeTeamName, "task_completed", {
          taskId: task.id,
          timeoutSeconds: params.timeout_seconds,
          signal,
        });
      }

      const waitText = waitResult
        ? waitResult.timedOut
          ? ` Wait for ${waitMode} timed out.`
          : ` Wait for ${waitMode} completed.`
        : "";

      return {
        content: [{
          type: "text",
          text: `Task ${task.id} delegated to ${safeName}${spawned ? ` in ${isWindow ? "window" : "pane"} ${terminalId}` : ""}.${waitText}`,
        }],
        details: { task: assigned, teammate: member, spawned, terminalId, isWindow, wait: waitResult },
      };
    },
  });

  pi.registerTool({
    name: "spawn_lead_window",
    label: "Spawn Lead Window",
    description: "Open the team lead in a separate OS window.",
    parameters: Type.Object({
      team_name: Type.String(),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      if (!terminal || !terminal.supportsWindows()) throw new Error("Windows mode not supported.");

      const teamConfig = await teams.readConfig(safeTeamName);
      const cwd = params.cwd || process.cwd();
      const piBinary = getPiLaunchCommand();
      let piCmd = piBinary;
      if (teamConfig.defaultModel) {
        // Use the combined --model provider/model format
        piCmd = `${piBinary} --model ${teamConfig.defaultModel}`;
      }

      const env = { ...process.env, PI_TEAM_NAME: safeTeamName, PI_AGENT_NAME: "team-lead" };
      try {
        const windowId = terminal.spawnWindow({ name: "team-lead", cwd, command: piCmd, env, teamName: safeTeamName });
        await teams.updateMember(safeTeamName, "team-lead", { windowId });
        return { content: [{ type: "text", text: `Lead window spawned: ${windowId}` }], details: { windowId } };
      } catch (e) {
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
    description: "Wait for a team event such as a message, submitted plan, task completion, or all tasks being done.",
    parameters: Type.Object({
      team_name: Type.String(),
      event: StringEnum(["message", "plan", "task_completed", "all_tasks_done"]),
      task_id: Type.Optional(Type.String({ description: "Optional task id for plan or task_completed waits." })),
      poll_interval_ms: Type.Optional(Type.Number({ description: "Polling interval in milliseconds. Defaults to 1000." })),
      timeout_seconds: Type.Optional(Type.Number({ description: "Optional timeout. Omit to wait indefinitely." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (params.event === "message") {
        const result = await messaging.waitForInbox(params.team_name, agentName, {
          pollIntervalMs: params.poll_interval_ms,
          timeoutSeconds: params.timeout_seconds,
          signal,
          onPoll: async () => {
            if (isTeammate && teamName && params.team_name === teamName) {
              try {
                await runtime.writeRuntimeStatus(teamName, agentName, {
                  lastHeartbeatAt: Date.now(),
                });
              } catch {
                // Heartbeat is best-effort while this tool is blocking.
              }
            }
          },
        });
        if (isTeammate && teamName && params.team_name === teamName) {
          const runtimeUpdates: Partial<runtime.AgentRuntimeStatus> = {
            lastHeartbeatAt: Date.now(),
            ready: true,
            lastError: undefined,
          };
          if (result.count > 0) runtimeUpdates.lastInboxReadAt = Date.now();
          await runtime.writeRuntimeStatus(teamName, agentName, runtimeUpdates);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      if ((params.event === "plan" || params.event === "task_completed") && !params.task_id) {
        throw new Error(`team_wait event '${params.event}' requires task_id to avoid matching historical task state.`);
      }

      const result = await waitForTaskEvent(params.team_name, params.event, {
        taskId: params.task_id,
        pollIntervalMs: params.poll_interval_ms,
        timeoutSeconds: params.timeout_seconds,
        signal,
        onPoll: async () => {
          if (isTeammate && teamName && params.team_name === teamName) {
            try {
              await runtime.writeRuntimeStatus(teamName, agentName, {
                lastHeartbeatAt: Date.now(),
              });
            } catch {
              // Heartbeat is best-effort while this tool is blocking.
            }
          }
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "plan_submit",
    label: "Submit Plan",
    description: "Submit a plan for a task and wait until the lead approves or rejects it.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      plan: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const evaluation = await tasks.submitPlanAndWaitForEvaluation(params.team_name, params.task_id, params.plan, {
        submittedBy: agentName,
        signal,
        onPoll: async () => {
          if (isTeammate && teamName && params.team_name === teamName) {
            try {
              await runtime.writeRuntimeStatus(teamName, agentName, {
                lastHeartbeatAt: Date.now(),
              });
            } catch {
              // Heartbeat is best-effort while this tool is blocking.
            }
          }
        },
      });
      const actionText = evaluation.action === "approve" ? "approved" : "rejected";

      return {
        content: [{ type: "text", text: `Plan submitted for task ${params.task_id} and ${actionText}.` }],
        details: { task: evaluation.task, evaluation },
      };
    },
  });

  pi.registerTool({
    name: "plan_review",
    label: "Review Plan",
    description: "Approve or reject a submitted task plan.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      decision: StringEnum(["approve", "reject"]),
      feedback: Type.Optional(Type.String({ description: "Required for rejection" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const updated = await tasks.evaluatePlan(params.team_name, params.task_id, params.decision as any, params.feedback, {
        evaluatedBy: agentName,
      });
      const actionText = params.decision === "approve" ? "approved" : "rejected";
      return {
        content: [{ type: "text", text: `Plan for task ${params.task_id} has been ${actionText}.` }],
        details: { task: updated },
      };
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
      const teamName = params.team_name;
      try {
        const config = await teams.readConfig(teamName);
        for (const member of config.members) {
          await killTeammate(teamName, member);
        }
        const dir = paths.teamDir(teamName);
        const tasksDir = paths.taskDir(teamName);
        if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true });
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

        // Clean up orphaned agent session folders (older than 1 hour)
        const cleanedSessions = cleanupAgentSessionFolders(60 * 60 * 1000);

        return {
          content: [{
            type: "text",
            text: `Team ${teamName} shut down.${cleanedSessions > 0 ? ` Cleaned up ${cleanedSessions} orphaned agent session folder(s).` : ""}`
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

      let alive = false;
      if (member.windowId && terminal) {
        alive = terminal.isWindowAlive(member.windowId);
      } else if (member.tmuxPaneId && terminal) {
        alive = terminal.isAlive(member.tmuxPaneId);
      }

      const unreadCount = (await messaging.readInbox(params.team_name, params.agent_name, true, false)).length;
      const runtimeStatus = await runtime.readRuntimeStatus(params.team_name, params.agent_name);
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt
        && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
      const startupStalled = alive
        && unreadCount > 0
        && (now - member.joinedAt) > runtime.STARTUP_STALL_MS
        && !(runtimeStatus?.ready);
      const health = !alive
        ? "dead"
        : startupStalled
          ? "stalled"
          : runtimeStatus?.ready
            ? (hasRecentHeartbeat ? "healthy" : "idle")
            : "starting";

      const details = {
        alive,
        unreadCount,
        health,
        agentLoopReady: !!runtimeStatus?.ready,
        hasRecentHeartbeat,
        startupStalled,
        runtime: runtimeStatus,
      };

      // Clean up runtime status for dead teammates
      if (!alive && runtimeStatus) {
        await runtime.deleteRuntimeStatus(params.team_name, params.agent_name);
      }

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
      const members = await Promise.all(config.members.map(async (member) => {
        const runtimeStatus = await runtime.readRuntimeStatus(params.team_name, member.name);
        const alive = member.name === "team-lead"
          ? true
          : member.windowId && terminal
            ? terminal.isWindowAlive(member.windowId)
            : member.tmuxPaneId && terminal
              ? terminal.isAlive(member.tmuxPaneId)
              : false;
        const unreadCount = (await messaging.readInbox(params.team_name, member.name, true, false)).length;
        return {
          name: member.name,
          agentType: member.agentType,
          alive,
          unreadCount,
          model: member.model,
          thinking: member.thinking,
          planModeRequired: member.planModeRequired,
          runtime: runtimeStatus,
        };
      }));

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
      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", `Predefined team: ${params.predefined_team}`, params.default_model, params.separate_windows);
      registerLeadSession(params.team_name);
      // Update teamName and start inbox polling for the lead
      teamName = params.team_name;
      startLeadInboxPolling();

      const agentDefinitions = predefined.getAllAgentDefinitions(projectDir);
      const spawnResults: Array<{ name: string; status: string; error?: string }> = [];

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
          
          let chosenModel = agentDef.model || params.default_model || config.defaultModel;
          
          if (chosenModel && !chosenModel.includes('/')) {
            const resolved = resolveModelWithProvider(chosenModel);
            if (resolved) {
              chosenModel = resolved;
            } else if (config.defaultModel && config.defaultModel.includes('/')) {
              const [provider] = config.defaultModel.split('/');
              chosenModel = `${provider}/${chosenModel}`;
            }
          }

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
            thinking: agentDef.thinking,
          };

          await teams.addMember(safeTeamName, member);
          await messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, agentDef.prompt, "Initial prompt from predefined team");

          const piBinary = getPiLaunchCommand();
          let piCmd = piBinary;

          if (chosenModel) {
            if (agentDef.thinking) {
              piCmd = `${piBinary} --model ${chosenModel}:${agentDef.thinking}`;
            } else {
              piCmd = `${piBinary} --model ${chosenModel}`;
            }
          } else if (agentDef.thinking) {
            piCmd = `${piBinary} --thinking ${agentDef.thinking}`;
          }

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
