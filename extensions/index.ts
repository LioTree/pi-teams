import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import { classifyTeamWaitPeer, waitForTeam } from "../src/utils/team-wait";
import { allocateSession, claimSession, findSessionMember, sessionIdentity, restoreTeamPanes } from "../src/utils/team-session";
import { launchReservedMember } from "../src/utils/member-launch";
import { isReloadedFor, readReloadReceipt, readReloadRequest, recordReloaded, reloadDue, requestTeamReload } from "../src/utils/team-reload";
import {
  parseModelRef,
  parseThinkingLevel,
  readModelChange,
  readModelChangeResult,
  recordModelChangeResult,
  requestModelChange,
} from "../src/utils/team-model";
import { withLock } from "../src/utils/lock";
import {
  acknowledgeAcceptedInspection,
  admitQuiescenceInspection,
  noteInspectionAccepted,
  openFormalGeneration,
  QUIESCENCE_MARKER,
  releaseAcceptedInspection,
} from "../src/utils/quiescence";
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
import { terminalClosesProcesses } from "../src/utils/terminal-adapter";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";
import * as predefined from "../src/utils/predefined-teams";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Pi reloads extensions without a module cache, so this marks when the code
// currently running was read from disk.
const EXTENSION_LOADED_AT = Date.now();
// Internal argument to the existing command, not a separately registered slash command.
const RELOAD_SELF_ACTION = "__self";

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

/** Each session has isolated closures; a late callback cannot acquire a new session's identity. */
export default function (pi: ExtensionAPI) {
  type SessionRuntime = {
    handlers: Map<string, (...args: any[]) => any>;
    tools: Map<string, any>;
    commands: Map<string, any>;
    invalidate: () => void;
  };
  const build = (): SessionRuntime => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const proxy = new Proxy(pi, { get(target, key) {
      if (key === "on") return (name: string, handler: (...args: any[]) => any) => {
        handlers.set(name, handler); return () => handlers.delete(name);
      };
      if (key === "registerTool") return (tool: any) => tools.set(tool.name, tool);
      if (key === "registerCommand") return (name: string, command: any) => commands.set(name, command);
      return Reflect.get(target, key);
    } });
    return { handlers, tools, commands, invalidate: createSessionExtension(proxy) };
  };
  let active = build();
  let started = false;
  for (const [name, tool] of active.tools) {
    pi.registerTool({ ...tool, execute: (...args: any[]) => active.tools.get(name).execute(...args) });
  }
  for (const [name, command] of active.commands) {
    pi.registerCommand?.(name, { ...command, handler: (...args: any[]) => active.commands.get(name).handler(...args) });
  }
  for (const name of active.handlers.keys()) {
    (pi.on as any)(name, (event: any, ctx: any) => {
      if (name === "session_start") {
        if (started) {
          const retired = active;
          retired.invalidate();
          active = build();
          const next = active;
          // Actual Pi normally emits shutdown first. This also makes repeated
          // startup dispatch safe for hosts reusing a factory/context.
          return Promise.resolve(retired.handlers.get("session_shutdown")?.(
            { type: "session_shutdown", reason: event.reason }, ctx,
          )).then(() => next.handlers.get(name)?.(event, ctx));
        }
        started = true;
      }
      return active.handlers.get(name)?.(event, ctx);
    });
  }
}

function createSessionExtension(pi: ExtensionAPI): () => void {
  let { agentName, isTeammate } = resolveAgentRole(process.env.PI_AGENT_NAME);
  const runtimeInstanceId = randomUUID();
  const processStartToken = runtime.getProcessStartToken(process.pid);
  let incomingLeadHandoffToken = process.env.PI_TEAM_HANDOFF_TOKEN;
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  const incomingRecoveryToken = process.env.PI_TEAM_RECOVERY_TOKEN;
  delete process.env.PI_TEAM_RECOVERY_TOKEN;
  const envTeamName = process.env.PI_TEAM_NAME;

  // Environment is only a launch hint. session_start must prove the exact Pi
  // identity (or the explicit live handoff token) before attaching any reader.
  let teamName: string | null | undefined = envTeamName;
  let identity: ReturnType<typeof sessionIdentity>;
  let recoveryOutcomes: Awaited<ReturnType<typeof restoreTeamPanes>> = [];
  // /team-resume <team> <member> claims first, then must not reopen every peer.
  let suppressAutomaticRestore = false;

  const terminal = getTerminalAdapter();

  let inboxPollingStarted = false;
  let inboxDeliveryInFlight = false;
  let inboxPollingTimer: ReturnType<typeof setInterval> | undefined;
  // In-flight unexpected-stop reports. Confirmed deletion drains this chain
  // and refuses their writes so a late inbox mkdir cannot recreate the team.
  let stopReportTail: Promise<void> = Promise.resolve();
  let dissolvingTeam: string | null = null;
  let sessionCtx: any = null;
  let agentLoopActive = false;
  // Set synchronously on an aborted settlement so an in-flight poll cannot
  // inject mail before the runtime file publish finishes. Cleared by a new
  // agent run, shutdown, or discovering this process no longer owns a live lease.
  let locallyInterrupted = false;
  let sessionStopping = false;
  // Bumped synchronously when a new run or shutdown supersedes an in-flight
  // interrupted publication, including one still waiting for the runtime lock.
  let runtimeGeneration = 0;
  // True while this session is inside agent_settled. Delivery must not re-enter it.
  let settlementActive = false;
  let acceptedInspection: { messageId: string; generation: number; runGeneration: number } | undefined;
  let inspectionAckPending = false;
  interface PendingInspectionRelease {
    messageId: string;
    generation: number;
    leaderInstanceId: string;
    runGeneration: number;
    attempts: number;
    inFlight: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }
  // Retained after an aborted settlement until the durable accepted record is
  // released or conclusively no longer ours. This duty never checks the
  // generation and never wakes the interrupted session; it only cleans up
  // metadata. It is not an acknowledgement and not a new inspection.
  let pendingInspectionRelease: PendingInspectionRelease | null = null;
  let pendingInterrupt: { generation: number; attempts: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  interface PendingResume {
    generation: number;
    settled: boolean;
    attempts: number;
    inFlight: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }
  // A direct run owns this obligation until its latest activity commits. A
  // failed running write must not strand the persisted interrupted lease.
  let pendingResume: PendingResume | null = null;
  interface PendingInboxDelivery {
    ids: string[];
    token: number;
    confirmed: boolean;
    ackAttempts: number;
    ackInFlight: boolean;
    ackLeaseLost: boolean;
    diagnosticAttempts: number;
    diagnosticShown: boolean;
    startedAt: number;
    ackTimer?: ReturnType<typeof setTimeout>;
    diagnosticTimer?: ReturnType<typeof setTimeout>;
  }
  let deliveryToken = 0;
  // Unknown acceptance stays on this object for the life of the process.
  // Timeouts, settlements, unrelated runs, and model selection must not replace it.
  let pendingInboxDelivery: PendingInboxDelivery | null = null;
  // Set only while this session's own reload command is awaiting ctx.reload().
  let reloadingForRequest: string | undefined;
  let reloadDispatchedAt = 0;
  const RELOAD_DISPATCH_TIMEOUT_MS = 10_000;
  const INTERRUPT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 5000];
  const INSPECTION_RELEASE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 5000];
  const ACK_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 5000];
  const INBOX_UNKNOWN_DIAGNOSTIC_MS = 1500;
  const INTERRUPTIBLE_ACTIVITIES = ["starting", "queued", "running", "waiting", "idle", "interrupted"] as const;
  const ROUTINE_SETTLE_ACTIVITIES = ["starting", "queued", "running", "waiting", "idle"] as const;
  const UNDELIVERABLE_ACTIVITIES = ["running", "waiting", "stopped", "interrupted"] as const;

  function clearPendingInterrupt() {
    if (pendingInterrupt?.timer) clearTimeout(pendingInterrupt.timer);
    pendingInterrupt = null;
  }

  function clearPendingResume() {
    if (pendingResume?.timer) clearTimeout(pendingResume.timer);
    pendingResume = null;
  }

  function resumeIsCurrent(pending: PendingResume): boolean {
    return pendingResume === pending
      && runtimeGeneration === pending.generation
      && !locallyInterrupted
      && !sessionStopping;
  }

  function scheduleResumeRetry(pending: PendingResume) {
    if (!resumeIsCurrent(pending) || pending.inFlight || pending.timer) return;
    // Cap the interval, not the lifetime of the recovery obligation.
    const delay = INTERRUPT_RETRY_DELAYS_MS[Math.min(pending.attempts++, INTERRUPT_RETRY_DELAYS_MS.length - 1)];
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void publishResumedActivity(pending).catch(() => undefined);
    }, delay);
  }

  async function publishResumedActivity(pending: PendingResume): Promise<runtime.AgentRuntimeStatus | null> {
    if (!teamName || !resumeIsCurrent(pending) || pending.inFlight) return null;
    pending.inFlight = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    const settled = pending.settled;
    const commitAllowed = () => resumeIsCurrent(pending) && pending.settled === settled;
    try {
      const activity = settled
        ? ((await messaging.readInbox(teamName, agentName, true, false)).length > 0 ? "queued" : "idle")
        : "running";
      if (!commitAllowed()) return null;
      const updated = await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        activity,
        pid: process.pid,
        processStartToken,
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
        paused: false,
      }, INTERRUPTIBLE_ACTIVITIES, commitAllowed);
      // Both the object and its target can change while waiting for the lock.
      // In particular a settled run must never be repaired back to running.
      if (!commitAllowed()) return null;
      if (updated) {
        clearPendingResume();
        if (pendingInboxDelivery) scheduleAckRetry(pendingInboxDelivery, 0);
        return updated;
      }
      const current = await runtime.readRuntimeStatus(teamName, agentName);
      if (resumeIsCurrent(pending) && (!current || current.instanceId !== runtimeInstanceId || current.activity === "stopped")) {
        clearPendingResume();
      }
      return null;
    } finally {
      pending.inFlight = false;
      // Includes exceptional writes/reads and a target changed during a lock
      // wait. Initial handler errors remain visible to Pi's ExtensionRunner.
      scheduleResumeRetry(pending);
    }
  }

  function clearPendingInboxDelivery() {
    const pending = pendingInboxDelivery;
    if (!pending) return;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (pending.diagnosticTimer) clearTimeout(pending.diagnosticTimer);
    pendingInboxDelivery = null;
  }

  function sameMessageIds(left: string[] | undefined, right: string[]): boolean {
    return !!left && left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function ownsDeliveryLease(status: runtime.AgentRuntimeStatus | null | undefined): status is runtime.AgentRuntimeStatus {
    return !!status && status.instanceId === runtimeInstanceId && !sessionStopping;
  }

  function waitAbort(): Error {
    const error = new Error("team_wait aborted");
    error.name = "AbortError";
    return error;
  }

  function userMessageText(message: { role?: string; content?: unknown }): string {
    if (message.role !== "user") return "";
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap(part => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }
      return [];
    }).join("\n");
  }

  function clearPendingInterruptIfCurrent(started: NonNullable<typeof pendingInterrupt>) {
    if (pendingInterrupt === started) clearPendingInterrupt();
  }

  async function publishInterrupted(): Promise<void> {
    const started = pendingInterrupt;
    if (!teamName || !started) return;
    const generation = started.generation;
    if (!interruptCommitAllowed(generation)) {
      clearPendingInterruptIfCurrent(started);
      return;
    }
    try {
      const updated = await runtime.updateRuntimeStatusForInstance(
        teamName,
        agentName,
        runtimeInstanceId,
        {
          activity: "interrupted",
          paused: true,
          pid: process.pid,
          processStartToken,
          lastHeartbeatAt: Date.now(),
        },
        INTERRUPTIBLE_ACTIVITIES,
        () => interruptCommitAllowed(generation),
      );
      // A newer publication may have replaced this one while the runtime lock
      // was held. Never clear its timer, pending object, or local pause.
      if (pendingInterrupt !== started) return;
      if (!updated || !interruptCommitAllowed(generation)) {
        clearPendingInterruptIfCurrent(started);
        if (!updated) {
          const current = await runtime.readRuntimeStatus(teamName, agentName);
          if (pendingInterrupt && pendingInterrupt !== started) return;
          if (!current || current.instanceId !== runtimeInstanceId || current.activity === "stopped") {
            locallyInterrupted = false;
          }
        }
        return;
      }
      clearPendingInterruptIfCurrent(started);
    } catch {
      if (pendingInterrupt !== started || !locallyInterrupted || sessionStopping) return;
      started.attempts += 1;
      if (started.timer) clearTimeout(started.timer);
      const delay = INTERRUPT_RETRY_DELAYS_MS[
        Math.min(started.attempts, INTERRUPT_RETRY_DELAYS_MS.length) - 1
      ];
      started.timer = setTimeout(() => {
        if (pendingInterrupt !== started) return;
        void publishInterrupted();
      }, delay);
    }
  }

  function ackStillAppropriate(pending: PendingInboxDelivery): boolean {
    return pendingInboxDelivery === pending
      && pending.confirmed
      && !pending.ackLeaseLost
      && !pendingResume
      && !locallyInterrupted
      && !sessionStopping;
  }

  function pauseAckRetry(pending: PendingInboxDelivery) {
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pending.ackTimer = undefined;
  }

  function scheduleAckRetry(pending: PendingInboxDelivery, delay = ACK_RETRY_DELAYS_MS[
    Math.min(Math.max(pending.ackAttempts, 1), ACK_RETRY_DELAYS_MS.length) - 1
  ]) {
    if (!ackStillAppropriate(pending) || pending.ackInFlight || pending.ackTimer) return;
    pending.ackAttempts += 1;
    pending.ackTimer = setTimeout(() => {
      pending.ackTimer = undefined;
      if (pendingInboxDelivery !== pending) return;
      // The recovery helper contains storage failures; keep a rejection handler
      // at the detached boundary as well (for example, a throwing host UI).
      void acknowledgeConfirmedDelivery(pending).catch(() => scheduleAckRetry(pending));
    }, delay);
  }

  function clearDeliveryStatusIfCurrent(pending: PendingInboxDelivery) {
    if (pendingInboxDelivery && pendingInboxDelivery.token !== pending.token) return;
    sessionCtx?.ui?.setStatus?.("pi-teams-delivery", undefined);
  }

  async function clearPublishedDiagnostic(pending: PendingInboxDelivery): Promise<void> {
    if (!teamName || sessionStopping) return;
    const updates: Partial<runtime.AgentRuntimeStatus> = { inboxAwaitingConfirmation: undefined };
    try {
      await runtime.updateRuntimeStatusForInstance(
        teamName,
        agentName,
        runtimeInstanceId,
        updates,
        undefined,
        (status) => ownsDeliveryLease(status) && (
          !status.inboxAwaitingConfirmation ||
          sameMessageIds(status.inboxAwaitingConfirmation.messageIds, pending.ids)
        ),
      );
    } catch {
      // The attempt may already have been retired. Retry only this clear, and
      // the runtime commit guard still refuses a newer attempt's diagnostic.
      if (sessionStopping || pending.diagnosticTimer) return;
      if (pendingInboxDelivery && pendingInboxDelivery.token !== pending.token) return;
      pending.diagnosticAttempts += 1;
      if (pending.diagnosticAttempts > ACK_RETRY_DELAYS_MS.length) return;
      const delay = ACK_RETRY_DELAYS_MS[pending.diagnosticAttempts - 1];
      pending.diagnosticTimer = setTimeout(() => {
        pending.diagnosticTimer = undefined;
        void clearPublishedDiagnostic(pending).catch(() => undefined);
      }, delay);
    }
  }

  async function finishAcceptedDelivery(pending: PendingInboxDelivery): Promise<void> {
    if (pendingInboxDelivery !== pending) return;
    clearPendingInboxDelivery();
    if (!teamName) {
      clearDeliveryStatusIfCurrent(pending);
      return;
    }
    // Timestamp update and diagnostic clear are separate commits. The clear
    // guard sees the runtime field under the lock, so an older finish cannot
    // erase a diagnostic published by a later attempt while this wait was blocked.
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      lastInboxReadAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    }, undefined, (status) => ownsDeliveryLease(status)).catch(() => undefined);
    await clearPublishedDiagnostic(pending).catch(() => undefined);
    clearDeliveryStatusIfCurrent(pending);
  }

  async function acknowledgeConfirmedDelivery(pending: PendingInboxDelivery): Promise<void> {
    if (!teamName || !ackStillAppropriate(pending) || pending.ackInFlight) return;
    pending.ackInFlight = true;
    pauseAckRetry(pending);
    try {
      let marked = 0;
      try {
        marked = await messaging.commitInboxAcknowledgement(
          teamName,
          agentName,
          pending.ids,
          (status) => {
            // Lease loss is terminal for this attempt. Interruption is not:
            // the persisted pause may still precede a resumed running publish.
            if (!status || status.instanceId !== runtimeInstanceId || status.activity === "stopped") {
              pending.ackLeaseLost = true;
            }
            return ackStillAppropriate(pending) && status?.activity !== "interrupted";
          },
        );
      } catch {
        // The fallback can discover metadata committed by another consumer.
        // It is fallible too, and remains inside the recovery try/finally.
      }
      if (pendingInboxDelivery !== pending) return;
      if (marked > 0) {
        // Retire a committed ACK before any fallible follow-up metadata/UI.
        await finishAcceptedDelivery(pending);
        return;
      }
      if (!ackStillAppropriate(pending)) return;
      const stillUnread = await messaging.readInbox(teamName, agentName, true, false);
      if (!ackStillAppropriate(pending)) return;
      if (!stillUnread.some(message => pending.ids.includes(message.id))) {
        await finishAcceptedDelivery(pending);
      }
    } catch {
      // Keep the accepted object on every recoverable read/lock/write failure.
      // Neither this path nor its timer ever re-injects the accepted prompt.
    } finally {
      pending.ackInFlight = false;
      // Recovery belongs to the current object/state, not the old commit's
      // snapshot. This also discharges a resume that raced an in-flight ACK.
      scheduleAckRetry(pending);
    }
  }

  function unknownDeliveryNote(pending: PendingInboxDelivery): string {
    return `Awaiting confirmation for inbox Message-ID ${pending.ids.join(", ")}. Acceptance is unknown, not a confirmed failure. This process will not send another copy.`;
  }

  async function reportUnknownDelivery(pending: PendingInboxDelivery): Promise<void> {
    if (pendingInboxDelivery !== pending || pending.confirmed || sessionStopping || !teamName) return;
    const note = unknownDeliveryNote(pending);
    if (!pending.diagnosticShown) {
      pending.diagnosticShown = true;
      sessionCtx?.ui?.notify?.(note, "warning");
      if (pendingInboxDelivery === pending && !pending.confirmed) {
        sessionCtx?.ui?.setStatus?.("pi-teams-delivery", `awaiting confirmation: ${pending.ids.join(", ")}`);
      }
    }
    const diagnostic = {
      messageIds: [...pending.ids],
      since: pending.startedAt,
      note,
    };
    try {
      const updated = await runtime.updateRuntimeStatusForInstance(
        teamName,
        agentName,
        runtimeInstanceId,
        {
          lastHeartbeatAt: Date.now(),
          inboxAwaitingConfirmation: diagnostic,
        },
        undefined,
        (status) => pendingInboxDelivery === pending
          && !pending.confirmed
          // This current unconfirmed object is the only publisher in this
          // lease. It may replace older IDs whose accepted cleanup failed.
          // Evaluate ownership under the runtime lock, never before awaiting it.
          && ownsDeliveryLease(status),
      );
      if (pendingInboxDelivery !== pending || pending.confirmed || updated) return;
    } catch {
      if (pendingInboxDelivery !== pending || pending.confirmed || sessionStopping || pending.diagnosticTimer) return;
      pending.diagnosticAttempts += 1;
      if (pending.diagnosticAttempts > ACK_RETRY_DELAYS_MS.length) return;
      const delay = ACK_RETRY_DELAYS_MS[pending.diagnosticAttempts - 1];
      pending.diagnosticTimer = setTimeout(() => {
        pending.diagnosticTimer = undefined;
        if (pendingInboxDelivery !== pending || pending.confirmed) return;
        void reportUnknownDelivery(pending).catch(() => undefined);
      }, delay);
    }
  }

  function scheduleUnknownDiagnostic(pending: PendingInboxDelivery) {
    if (pending.diagnosticTimer) clearTimeout(pending.diagnosticTimer);
    pending.diagnosticTimer = setTimeout(() => {
      pending.diagnosticTimer = undefined;
      if (pendingInboxDelivery !== pending || pending.confirmed) return;
      void reportUnknownDelivery(pending).catch(() => undefined);
    }, INBOX_UNKNOWN_DIAGNOSTIC_MS);
  }

  function interruptCommitAllowed(generation: number): boolean {
    return pendingInterrupt?.generation === generation
      && runtimeGeneration === generation
      && locallyInterrupted
      && !sessionStopping;
  }

  function leaseCanDeliver(status: runtime.AgentRuntimeStatus | null | undefined): status is runtime.AgentRuntimeStatus {
    return !!status
      && status.instanceId === runtimeInstanceId
      && !UNDELIVERABLE_ACTIVITIES.includes(status.activity as typeof UNDELIVERABLE_ACTIVITIES[number]);
  }

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
    if (
      inboxDeliveryInFlight ||
      pendingInboxDelivery ||
      agentLoopActive ||
      settlementActive ||
      locallyInterrupted ||
      sessionStopping ||
      !teamName ||
      !sessionCtx?.isIdle()
    ) return;
    inboxDeliveryInFlight = true;
    try {
      const leaseBeforeRead = await runtime.readRuntimeStatus(teamName, agentName);
      // Recheck after every await. An aborted settlement or replacement can
      // land while this poll is in flight and must not be resumed from here.
      if (locallyInterrupted || sessionStopping || settlementActive || agentLoopActive || !leaseCanDeliver(leaseBeforeRead)) return;

      const unread = await messaging.readInbox(teamName, agentName, true, false);
      const leaseAfterRead = await runtime.readRuntimeStatus(teamName, agentName);
      if (locallyInterrupted || sessionStopping || settlementActive || agentLoopActive || !sessionCtx.isIdle() || !leaseCanDeliver(leaseAfterRead)) return;

      if (unread.length === 0) {
        if (leaseAfterRead.activity === "queued") {
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
      if (leaseAfterRead.activity === "idle") {
        await runtime.markRuntimeQueuedIfIdle(teamName, agentName);
      }
      const leaseBeforeDelivery = await runtime.readRuntimeStatus(teamName, agentName);
      if (locallyInterrupted || sessionStopping || settlementActive || agentLoopActive || !sessionCtx.isIdle() || !leaseCanDeliver(leaseBeforeDelivery)) return;
      const deliveryBatch = unread.slice(0, 1);

      // pi.sendUserMessage returns void before Pi accepts the prompt. That
      // return, a timer, or a missing error is not acceptance. Keep this
      // attempt single-flight and unread until a matching user message_end.
      if (locallyInterrupted || sessionStopping || settlementActive || pendingInboxDelivery) return;
      const pending: PendingInboxDelivery = {
        ids: deliveryBatch.map(message => message.id),
        token: ++deliveryToken,
        confirmed: false,
        ackAttempts: 0,
        ackInFlight: false,
        ackLeaseLost: false,
        diagnosticAttempts: 0,
        diagnosticShown: false,
        startedAt: Date.now(),
      };
      pendingInboxDelivery = pending;
      scheduleUnknownDiagnostic(pending);
      pi.sendUserMessage(formatInboxDelivery(deliveryBatch));
    } catch (error) {
      if (teamName && !locallyInterrupted) {
        await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
          lastHeartbeatAt: Date.now(),
          lastError: runtime.createRuntimeError(error),
        }).catch(() => undefined);
      }
    } finally {
      inboxDeliveryInFlight = false;
    }
  }

  async function pollTeamCoordination(): Promise<void> {
    await applyRequestedModelChange().catch(() => undefined);
    await deliverUnreadInbox();
    if (pendingInspectionRelease && !settlementActive && !sessionStopping) {
      // Retry metadata-only cleanup even while paused. This neither starts a
      // model nor admits an inspection; the backoff timer owns the pace.
      await attemptInspectionRelease().catch(() => undefined);
    }
    if (inspectionAckPending && !settlementActive && !locallyInterrupted && !sessionStopping) {
      await acknowledgeInspectionAfterSettlement().catch(() => undefined);
    }
    if (
      teamName
      && !locallyInterrupted
      && !sessionStopping
      && !settlementActive
      && !agentLoopActive
      && sessionCtx?.isIdle()
    ) {
      await admitQuiescenceInspection(teamName, { isMemberAlive }).catch(() => undefined);
    }
    dispatchRequestedReload();
    if (!isTeammate && teamName && !sessionStopping) {
      await reportUnexpectedStops(teamName).catch(() => undefined);
    }
  }

  // A reload replaces this closure, so it must wait until no in-memory duty
  // (delivery, receipt, inspection ACK/release, activity retry) would be lost.
  // An interrupted session may reload: its pause is persisted and restored.
  function reloadIsSafe(): boolean {
    return !!teamName
      && !sessionStopping
      && !settlementActive
      && !agentLoopActive
      && !!sessionCtx?.isIdle()
      && !inboxDeliveryInFlight
      && !pendingInboxDelivery
      && !acceptedInspection
      && !inspectionAckPending
      && !pendingInspectionRelease
      && !pendingInterrupt
      && !pendingResume;
  }

  function dueReloadRequest() {
    if (!teamName) return undefined;
    const request = readReloadRequest(teamName);
    if (!request) return undefined;
    const receipt = readReloadReceipt(teamName, agentName);
    if (EXTENSION_LOADED_AT > request.requestedAt && !isReloadedFor(request, receipt)) {
      // Code loaded after the request (including by this reload) is current.
      try { recordReloaded(teamName, agentName, request.id); } catch {}
    }
    return reloadDue(request, EXTENSION_LOADED_AT) ? request : undefined;
  }

  let modelChangeInFlight = false;

  /**
   * Apply a lead-requested model switch inside this process. `pi.setModel`
   * is host state: it does not start a turn and does not ask this session's
   * model to do anything, so it still runs when that model has no quota.
   * An in-flight turn keeps the old model until it ends. Pause is untouched.
   */
  async function applyRequestedModelChange(): Promise<void> {
    if (!teamName || sessionStopping || modelChangeInFlight || typeof pi.setModel !== "function") return;
    const request = readModelChange(teamName, agentName);
    if (!request) return;
    if (readModelChangeResult(teamName, agentName)?.requestId === request.id) return;
    const parsed = parseModelRef(request.model);
    const registry = sessionCtx?.modelRegistry;
    const model = parsed && registry?.find ? registry.find(parsed.provider, parsed.id) : undefined;
    if (!parsed || !model) {
      const error = !parsed ? "model must be provider/id" : `unknown model ${request.model}`;
      recordModelChangeResult(teamName, agentName, { requestId: request.id, ok: false, error });
      sessionCtx?.ui?.notify?.(`Model change refused: ${error}`, "warning");
      return;
    }
    modelChangeInFlight = true;
    try {
      const ok = await pi.setModel(model);
      if (!ok) {
        recordModelChangeResult(teamName, agentName, {
          requestId: request.id, ok: false, error: "no authentication for this provider",
        });
        sessionCtx?.ui?.notify?.(`Model change refused: no authentication for ${request.model}`, "warning");
        return;
      }
      if (request.thinking) pi.setThinkingLevel?.(request.thinking);
      await teams.updateMember(teamName, agentName, {
        model: request.model,
        ...(request.thinking ? { thinking: request.thinking } : {}),
      });
      recordModelChangeResult(teamName, agentName, { requestId: request.id, ok: true });
      sessionCtx?.ui?.notify?.(
        `Model is now ${request.model}${request.thinking ? ` (${request.thinking})` : ""}. An in-flight turn keeps the previous model until it ends.`,
        "info",
      );
    } catch {
      // Host or roster write failed before a result was recorded. Retry next poll.
    } finally {
      modelChangeInFlight = false;
    }
  }

  function dispatchRequestedReload() {
    if (!teamName || sessionStopping || reloadingForRequest || Date.now() - reloadDispatchedAt < RELOAD_DISPATCH_TIMEOUT_MS) return;
    const request = dueReloadRequest();
    if (!request || !reloadIsSafe()) return;
    reloadDispatchedAt = Date.now();
    // Use the existing command's internal branch so autocomplete exposes no
    // helper command. This reaches no model and does not resume a paused run.
    pi.sendUserMessage(`/team-reload ${RELOAD_SELF_ACTION} ${request.id}`, { expandPromptTemplates: true });
  }

  async function acknowledgeInspectionAfterSettlement(): Promise<void> {
    const accepted = acceptedInspection;
    if (!accepted || !teamName || isTeammate || locallyInterrupted || sessionStopping) return;
    const lease = await runtime.readRuntimeStatus(teamName, agentName);
    if (!lease || lease.instanceId !== runtimeInstanceId || lease.activity === "stopped") {
      if (acceptedInspection === accepted) acceptedInspection = undefined;
      inspectionAckPending = false;
      return;
    }
    try {
      const ack = await acknowledgeAcceptedInspection(teamName, {
        messageId: accepted.messageId,
        leaderInstanceId: runtimeInstanceId,
        runGeneration: accepted.runGeneration,
      }, {
        stillAuthorized: async () => {
          // The in-memory obligation can be revoked while this settlement or a
          // poll retry waits for the coordinator lock (abort, stop, shutdown),
          // and the runtime lease can be replaced by another lead process.
          const stillOurs = () => acceptedInspection === accepted
            && !locallyInterrupted
            && !sessionStopping;
          if (!stillOurs()) return "revoked" as const;
          const current = await runtime.readRuntimeStatus(teamName!, agentName);
          if (!stillOurs()) return "revoked" as const;
          return current
            && current.instanceId === runtimeInstanceId
            && current.activity !== "stopped"
            ? "authorized" as const
            : "not-ours" as const;
        },
      });
      if (ack.checked) {
        if (acceptedInspection === accepted) acceptedInspection = undefined;
        inspectionAckPending = false;
        return;
      }
      if (ack.decision === "revoked") {
        // The obligation was revoked while the commit waited, so this ACK must
        // never check. Do not discard the durable record with it: hand it to
        // the release duty. If the abort path already took ownership, it has
        // already retained the same duty.
        if (acceptedInspection === accepted) {
          acceptedInspection = undefined;
          retainInspectionRelease(accepted);
          await attemptInspectionRelease(true).catch(() => undefined);
        }
        inspectionAckPending = false;
        return;
      }
      // not-ours: the durable record was released, replaced, or never matched
      // this writer. Conclusive ownership loss, so drop the local obligation.
      if (acceptedInspection === accepted) acceptedInspection = undefined;
      inspectionAckPending = false;
    } catch {
      inspectionAckPending = true;
    }
  }

  async function releaseInspectionAfterAbort(): Promise<void> {
    const accepted = acceptedInspection;
    if (!accepted || !teamName) return;
    // The aborted run must never acknowledge its inspection. Move the duty to a
    // lease/run/message-bound release obligation that survives a transient
    // cleanup failure, then clear the normal ACK record immediately.
    if (acceptedInspection === accepted) acceptedInspection = undefined;
    inspectionAckPending = false;
    retainInspectionRelease(accepted);
    await attemptInspectionRelease(true).catch(() => undefined);
  }

  function clearPendingInspectionRelease() {
    if (pendingInspectionRelease?.timer) clearTimeout(pendingInspectionRelease.timer);
    pendingInspectionRelease = null;
  }

  function scheduleInspectionReleaseRetry(pending: PendingInspectionRelease) {
    if (pendingInspectionRelease !== pending || pending.inFlight || pending.timer) return;
    // Cap the interval, not the lifetime of the release obligation.
    const delay = INSPECTION_RELEASE_RETRY_DELAYS_MS[Math.min(pending.attempts++, INSPECTION_RELEASE_RETRY_DELAYS_MS.length - 1)];
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void attemptInspectionRelease().catch(() => undefined);
    }, delay);
  }

  function retainInspectionRelease(accepted: { messageId: string; generation: number; runGeneration: number }) {
    if (pendingInspectionRelease && (pendingInspectionRelease.runGeneration > accepted.runGeneration
      || pendingInspectionRelease.messageId === accepted.messageId && pendingInspectionRelease.runGeneration === accepted.runGeneration)) return;
    clearPendingInspectionRelease();
    pendingInspectionRelease = {
      ...accepted,
      leaderInstanceId: runtimeInstanceId,
      attempts: 0,
      inFlight: false,
    };
  }

  // Durable metadata cleanup only. `false` means the durable accepted record is
  // no longer ours (released, replaced, or gone), so the obligation is
  // conclusively finished; a thrown error keeps it for a bounded-backoff retry.
  async function attemptInspectionRelease(force = false): Promise<boolean> {
    const pending = pendingInspectionRelease;
    if (!pending || !teamName || pending.inFlight) return false;
    if (pending.timer && !force) return false;
    pending.inFlight = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    let failed = false;
    try {
      const released = await releaseAcceptedInspection(teamName, {
        messageId: pending.messageId,
        leaderInstanceId: pending.leaderInstanceId,
        runGeneration: pending.runGeneration,
      });
      if (pendingInspectionRelease === pending) clearPendingInspectionRelease();
      return released;
    } catch {
      failed = true;
      return false;
    } finally {
      // Clear in-flight before arming the retry; the scheduler refuses to arm
      // while this attempt still looks in flight.
      pending.inFlight = false;
      if (failed && pendingInspectionRelease === pending) scheduleInspectionReleaseRetry(pending);
    }
  }

  async function finishAgentSettlement(aborted: boolean): Promise<void> {
    try {
      if (teamName) {
        if (aborted || locallyInterrupted) {
          await releaseInspectionAfterAbort();
        } else {
          // Finish an outstanding abort-release before acknowledging, so a
          // normal settlement cannot strand the cleanup duty.
          await attemptInspectionRelease(true).catch(() => undefined);
          await acknowledgeInspectionAfterSettlement();
        }
      }
      // Append only. The poller must not inject until this settlement returns.
      if (!aborted && !locallyInterrupted && !sessionStopping && teamName) {
        await admitQuiescenceInspection(teamName, { isMemberAlive }).catch(() => undefined);
      }
    } catch {
      // A failed watermark write is retried by this process. It is not a new dispatch.
    } finally {
      settlementActive = false;
    }
  }

  function startInboxPolling() {
    if (inboxPollingStarted || !sessionCtx || !teamName) return;
    inboxPollingStarted = true;
    void pollTeamCoordination();
    inboxPollingTimer = setInterval(() => void pollTeamCoordination(), 1000);
  }

  function stopInboxPolling() {
    if (inboxPollingTimer) clearInterval(inboxPollingTimer);
    inboxPollingTimer = undefined;
    inboxPollingStarted = false;
  }

  pi.on("session_start", attachSession);
  async function attachSession(event: { reason?: string }, ctx: any): Promise<void> {
    teamName = null;
    paths.ensureDirs();
    sessionCtx = ctx;
    const handoffToken = incomingLeadHandoffToken;
    incomingLeadHandoffToken = undefined;
    let attached = false;
    try {
      identity = sessionIdentity(ctx);
      if (!identity) {
        if (envTeamName) ctx.ui.notify("Team recovery blocked: this Pi session has no persistent session file.", "warning");
        return;
      }
      const saved = findSessionMember(identity, envTeamName);
      // Only a current-process reload may migrate a legacy env hint. A startup,
      // new/fork/clone, or copied custom entry cannot establish that association.
      const legacyReload = event.reason === "reload" && !!envTeamName;
      const candidate = saved?.teamName ?? ((handoffToken || legacyReload) ? envTeamName : undefined);
      if (!candidate) {
        if (envTeamName) ctx.ui.notify("No exact team/session mapping; legacy data is preserved, not guessed or deleted.", "warning");
        agentName = "team-lead"; isTeammate = false;
        return;
      }
      const memberName = saved?.member.name ?? (handoffToken ? "team-lead" : agentName);
      // Remember the candidate for stale-session shutdown CAS even if a switch
      // happens just after the claim commits but before its await returns.
      teamName = candidate;
      agentName = memberName;
      isTeammate = memberName !== "team-lead";
      const claimed = await claimSession({ team: candidate, agent: memberName, identity,
        instanceId: runtimeInstanceId, pid: process.pid, processStartToken,
        paneId: process.env.TMUX_PANE, handoffToken, recoveryToken: incomingRecoveryToken, legacyReload,
        sameProcessReload: event.reason === "reload", current: () => !sessionStopping });
      attached = true;
      if (sessionStopping) return;
      teamName = candidate;
      agentName = memberName;
      isTeammate = memberName !== "team-lead";
      locallyInterrupted = claimed.activity === "interrupted";
      if (claimed.inboxAwaitingConfirmation) {
        // Keep unknown acceptance single-flight in the recovered process, too.
        // No receipt is invented and a resume does not submit a second copy.
        pendingInboxDelivery = {
          ids: claimed.inboxAwaitingConfirmation.messageIds, token: ++deliveryToken,
          confirmed: false, ackAttempts: 0, ackInFlight: false, ackLeaseLost: false,
          diagnosticAttempts: 0, diagnosticShown: false, startedAt: claimed.inboxAwaitingConfirmation.since,
        };
        await reportUnknownDelivery(pendingInboxDelivery);
      }
      if (sessionStopping) return;
      if (isTeammate) {
        atomicWriteFileSync(path.join(paths.teamDir(teamName), `${agentName}.pid`), process.pid.toString());
        ctx.ui.setStatus("00-pi-teams", `[${agentName.toUpperCase()}]`);
      } else ctx.ui.setStatus("pi-teams", `Lead @ ${teamName}`);
      // A same-process reload has no lost panes to restore, and peers may be
      // mid-reload themselves. `/team-resume` remains the explicit retry.
      // A named /team-resume suppresses this pass and restores only that member.
      const skipRestore = suppressAutomaticRestore;
      suppressAutomaticRestore = false;
      if (!isTeammate && event.reason !== "reload" && !skipRestore) {
        recoveryOutcomes = await restoreTeamPanes({ team: teamName, leaderInstanceId: runtimeInstanceId,
          terminal, piBinary: getPiLaunchCommand(), anchorPaneId: process.env.TMUX_PANE,
          current: () => !sessionStopping });
        if (!sessionStopping && recoveryOutcomes.length) ctx.ui.notify(
          recoveryOutcomes.map(item => `${item.name}: ${item.status}${item.note ? ` — ${item.note}` : ""}`).join("\n"),
          recoveryOutcomes.some(item => item.status === "blocked") ? "warning" : "info");
      }
      if (!sessionStopping) startInboxPolling();
      if (!sessionStopping && terminal) terminal.setTitle(`${teamName}: ${agentName}`);
    } catch (error) {
      if (attached) {
        // A PID-file/UI/pane-restoration failure after successful admission must
        // not strand our live runtime lease without its inbox consumer.
        if (!sessionStopping) startInboxPolling();
      } else {
        stopInboxPolling();
        teamName = null;
        agentName = "team-lead"; isTeammate = false;
      }
      ctx.ui.notify(`Team recovery ${attached ? "attached with a restoration fault" : "blocked"}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  pi.registerCommand("team-resume", {
    description: "Reopen missing roster sessions for this lead: /team-resume <team> [member]. Omitting the member reopens every missing teammate. Never forces a live owner, never starts a new conversation, and never replays tasks.",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const requested = paths.sanitizeName(parts[0] ?? "");
      const member = parts[1] ? paths.sanitizeName(parts[1]) : undefined;
      if (!requested || parts.length > 2) throw new Error("Usage: /team-resume <team> [member]");
      if (sessionStopping) throw new Error("Session is detaching");
      const actual = sessionIdentity(ctx);
      if (!actual) throw new Error("Persistent Pi session required");
      if (teamName && (teamName !== requested || isTeammate)) throw new Error("Already attached to another team/member");
      const wasAttached = !!teamName;
      if (!wasAttached) {
        const saved = findSessionMember(actual);
        if (saved && (saved.teamName !== requested || saved.member.agentType !== "lead")) throw new Error("This conversation is already bound to another team/member");
        if (member) suppressAutomaticRestore = true;
        try {
          await claimSession({ team: requested, agent: "team-lead", identity: actual,
            instanceId: runtimeInstanceId, pid: process.pid, processStartToken, manualAssociation: true,
            paneId: process.env.TMUX_PANE, current: () => !sessionStopping });
          // Now metadata has an exact mapping; use the normal attachment path.
          await attachSession({ reason: "resume" }, ctx);
        } finally {
          suppressAutomaticRestore = false;
        }
      }
      if (teamName !== requested) return;
      // A fresh attach with no member already restored every missing peer.
      if (!member && !wasAttached) return;
      if (member) {
        const config = await teams.readConfig(requested);
        if (!config.members.some(item => item.name === member && item.agentType !== "lead" && item.name !== "team-lead")) {
          throw new Error(`No teammate named ${member}`);
        }
      }
      recoveryOutcomes = await restoreTeamPanes({ team: requested, leaderInstanceId: runtimeInstanceId,
        terminal, piBinary: getPiLaunchCommand(), anchorPaneId: process.env.TMUX_PANE,
        members: member ? [member] : undefined,
        current: () => !sessionStopping });
      if (!sessionStopping) ctx.ui.notify(recoveryOutcomes.map(item => `${item.name}: ${item.status}${item.note ? ` — ${item.note}` : ""}`).join("\n") || "No missing roster members.", "info");
    },
  });

  pi.registerCommand("team-model", {
    description: "Switch a live teammate session to another model. The teammate extension applies it; the teammate model is not asked, so this works when that model has no quota. An in-flight turn keeps the old model until it ends. `/team-model status` reports results.",
    handler: async (args, ctx) => {
      if (sessionStopping) throw new Error("Session is detaching");
      if (!teamName) throw new Error("This session is not attached to a team");
      await assertLiveLead(teamName, "change a teammate model");
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const config = await teams.readConfig(teamName);
      const teammates = config.members.filter(member => member.agentType !== "lead" && member.name !== "team-lead");
      if (parts.length === 0 || parts[0] === "status") {
        const lines = teammates.map(member => {
          const request = readModelChange(teamName!, member.name);
          const result = readModelChangeResult(teamName!, member.name);
          if (!request) return `${member.name}: no request`;
          if (result?.requestId !== request.id) return `${member.name}: pending ${request.model}`;
          return result.ok
            ? `${member.name}: ${request.model}${request.thinking ? ` (${request.thinking})` : ""}`
            : `${member.name}: refused (${result.error ?? "failed"})`;
        });
        ctx.ui.notify(lines.join("\n") || "No teammates.", "info");
        return;
      }
      const [name, spec, thinkingRaw, extra] = parts;
      if (!spec || extra) throw new Error("Usage: /team-model <teammate> <provider/model> [thinking]");
      const { agent, request } = await submitTeammateModelChange(teamName, name!, spec, thinkingRaw);
      ctx.ui.notify(
        `Requested ${request.model}${request.thinking ? ` (${request.thinking})` : ""} for ${agent}. That session's extension applies it directly; the teammate model is not asked. An in-flight turn keeps the old model until it ends.`,
        "info",
      );
    },
  });

  async function submitTeammateModelChange(team: string, name: string, spec: string, thinkingRaw?: string) {
    await assertLiveLead(team, "change a teammate model");
    const agent = paths.sanitizeName(name);
    const parsed = parseModelRef(spec);
    if (!parsed) throw new Error("Model must be provider/id, for example xai/grok-4.7");
    const thinking = parseThinkingLevel(thinkingRaw);
    if (thinkingRaw && !thinking) throw new Error(`Thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    const config = await teams.readConfig(team);
    if (!config.members.some(member => member.name === agent && member.agentType !== "lead" && member.name !== "team-lead")) {
      throw new Error(`No teammate named ${agent}`);
    }
    return { agent, request: requestModelChange(team, agent, `${parsed.provider}/${parsed.id}`, thinking) };
  }

  pi.registerTool({
    name: "team_set_model",
    label: "Set Teammate Model",
    description: "Change a teammate's model through its extension, without asking or running the teammate model. Works even when its old model has no quota; interrupted sessions stay paused. Only the target team's live lead may call this. Supplying model queues a request and returns pending, NOT proof of success. Omit model to query the latest request: pending, applied, refused, or no_request. Check applied before claiming success; do not resubmit just to poll. Not dispatch: does not open a work generation. In-flight turns keep their old model.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
      model: Type.Optional(Type.String({ description: "Override as provider/model. Omit to query status without sending another request." })),
      thinking: Type.Optional(Type.Union(THINKING_LEVELS.map(level => Type.Literal(level)))),
    }),
    async execute(_toolCallId, params) {
      await assertLiveLead(params.team_name, "change a teammate model");
      if (!params.model && params.thinking) throw new Error("thinking requires model");
      const config = await teams.readConfig(params.team_name);
      const agent = paths.sanitizeName(params.agent_name);
      if (!config.members.some(member => member.name === agent && member.agentType !== "lead" && member.name !== "team-lead")) {
        throw new Error(`No teammate named ${agent}`);
      }
      const submitted = params.model
        ? await submitTeammateModelChange(params.team_name, agent, params.model, params.thinking)
        : undefined;
      const request = submitted?.request ?? readModelChange(params.team_name, agent);
      const result = readModelChangeResult(params.team_name, agent);
      const status = submitted ? "pending" : !request ? "no_request"
        : result?.requestId !== request.id ? "pending" : result.ok ? "applied" : "refused";
      const details = {
        team_name: params.team_name, agent_name: agent, status,
        request_id: request?.id, model: request?.model, thinking: request?.thinking,
        ...(status === "refused" ? { error: result?.error } : {}),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });

  pi.registerCommand("team-reload", {
    description: "Reload pi-teams code in every team member once it is idle (`/team-reload status` shows progress). Busy members finish their current run first.",
    handler: async (args, ctx) => {
      const [action, requestId, ...extra] = args.trim().split(/\s+/);
      if (action === RELOAD_SELF_ACTION) {
        reloadDispatchedAt = 0;
        const request = dueReloadRequest();
        if (!request || request.id !== requestId || extra.length || reloadingForRequest || !reloadIsSafe()) return;
        reloadingForRequest = request.id;
        await ctx.reload();
        // If the host refused (e.g. a run started), leave this request retryable.
        // On success the old closure is retired and must not be reused.
        if (!sessionStopping) reloadingForRequest = undefined;
        return;
      }
      if (!teamName) throw new Error("This session is not attached to a team");
      if (isTeammate) throw new Error("Only the team lead can request a team reload");
      const team = teamName;
      if (args.trim() !== "status") {
        requestTeamReload(team);
        reloadDispatchedAt = 0;
      }
      const request = readReloadRequest(team);
      if (!request) {
        ctx.ui.notify("No team reload has been requested.", "info");
        return;
      }
      const config = await teams.readConfig(team);
      const lines = await Promise.all(config.members.map(async member => {
        if (isReloadedFor(request, readReloadReceipt(team, member.name))) return `${member.name}: reloaded`;
        const status = await runtime.readRuntimeStatus(team, member.name);
        return `${member.name}: pending (${status?.reloading ? "reloading" : status?.activity ?? "not running"})`;
      }));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("team-close", {
    description: "Close one teammate pane, or every teammate pane. /team-close <member> leaves the lead attached. /team-close (or /team-close <team>) closes every teammate and then exits this lead Pi back to its shell when every pane that needed closing actually closed. Membership, tasks, inbox, and original sessions stay. Busy runs are killed. Only this team's live lead can run it.",
    handler: async (args, ctx) => {
      if (sessionStopping) throw new Error("Session is detaching");
      const target = await resolveCloseTarget(args);
      await performClose(target.team, target.member, ctx);
    },
  });

  pi.registerCommand("team-shutdown", {
    description: "Delete this saved team after every required teammate close succeeds. Requires the word confirm: /team-shutdown confirm. A lease change or a refused terminal close leaves the team in place. Pi conversation history stays, but a successful deletion removes the roster and cannot be restored. Only this team's live lead can run it. This is not how you finish work.",
    handler: async (args, ctx) => {
      const target = resolveShutdownTarget(args);
      const result = await shutdownTeam(target, ctx);
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.on("message_end", async (event) => {
    const pending = pendingInboxDelivery;
    if (!pending || pending.confirmed || !teamName || locallyInterrupted || sessionStopping) return;
    const text = userMessageText(event.message ?? {});
    if (!text.includes("[pi-teams inbox delivery]")) return;
    if (!pending.ids.every(id => text.includes(`Message-ID: ${id}`))) return;
    pending.confirmed = true;
    if (pending.diagnosticTimer) clearTimeout(pending.diagnosticTimer);
    pending.diagnosticTimer = undefined;
    if (pendingInboxDelivery === pending) {
      sessionCtx?.ui?.setStatus?.("pi-teams-delivery", `acknowledgement pending: ${pending.ids.join(", ")}`);
    }
    // Acceptance is this user message_end plus the delivered ids. A void send,
    // a timer, or an assistant message_end cannot reach this point.
    if (!isTeammate && agentLoopActive && text.includes(QUIESCENCE_MARKER)) {
      const messageId = pending.ids.find(id => text.includes(`Message-ID: ${id}`));
      if (messageId) {
        try {
          const receiptRun = runtimeGeneration;
          const receiptCurrent = () => !sessionStopping && !locallyInterrupted
            && agentLoopActive && runtimeGeneration === receiptRun;
          const noted = await noteInspectionAccepted(teamName, {
            messageId,
            leaderInstanceId: runtimeInstanceId,
            runGeneration: receiptRun,
            deliveredText: text,
            commitGuard: async () => {
              if (!receiptCurrent()) return false;
              const lease = await runtime.readRuntimeStatus(teamName!, agentName);
              return receiptCurrent() && lease?.instanceId === runtimeInstanceId && lease.activity !== "stopped";
            },
          });
          if (noted.accepted && noted.generation !== undefined) {
            const accepted = { messageId, generation: noted.generation, runGeneration: receiptRun };
            if (receiptCurrent()) {
              acceptedInspection = accepted;
              inspectionAckPending = false;
            } else {
              // Interruption/replacement after a committed receipt must not lose
              // the durable acceptance nor let an unrelated run acknowledge it.
              retainInspectionRelease(accepted);
              await attemptInspectionRelease(true);
            }
          }
        } catch {
          // Inbox acknowledgement below still proceeds. A later settlement retry
          // can record the same accepted ids; this does not open a generation.
        }
      }
    }
    // Acceptance is known now. Clear the unknown diagnostic even if the later
    // mailbox acknowledgement fails, and do not let an in-flight unknown writer
    // publish after this point: its commit guard observes pending.confirmed.
    await clearPublishedDiagnostic(pending);
    await acknowledgeConfirmedDelivery(pending);
  });

  pi.on("agent_start", async () => {
    // A direct user prompt starts a new run. Model selection alone does not
    // emit this event and must not clear an interruption or an unknown inbox
    // attempt. Bump generation before any await so a stale interrupted-publication
    // retry cannot overwrite this run or clear the new publication.
    const generation = ++runtimeGeneration;
    agentLoopActive = true;
    locallyInterrupted = false;
    clearPendingInterrupt();
    clearPendingResume();
    if (!teamName || sessionStopping) return;
    // A direct resume is a legitimate moment to finish metadata cleanup quickly.
    if (pendingInspectionRelease) await attemptInspectionRelease(true).catch(() => undefined);
    const pending: PendingResume = { generation, settled: false, attempts: 0, inFlight: false };
    pendingResume = pending;
    await publishResumedActivity(pending);
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

  pi.on("agent_settled", async (event) => {
    settlementActive = true;
    try {
      await settleAgentRun(event);
    } finally {
      await finishAgentSettlement(event.aborted === true);
    }
  });

  async function settleAgentRun(event: { aborted?: boolean }): Promise<void> {
    const aborted = event.aborted === true;
    const generation = runtimeGeneration;
    const resume = pendingResume;
    // Invalidate a running repair synchronously, before any runtime lock wait.
    if (aborted) clearPendingResume();
    else if (resume) resume.settled = true;
    const settleCommitAllowed = () => runtimeGeneration === generation
      && !agentLoopActive && !locallyInterrupted && !sessionStopping;
    // Flip the pause before the first await. Pi has already dropped the run
    // lock, so the idle poller can otherwise inject and resume this session.
    if (aborted) {
      locallyInterrupted = true;
      // Keep the unknown or accepted-but-unacked attempt. Clearing it would
      // let a later poll send a second copy. Do not acknowledge paused mail.
      if (pendingInboxDelivery?.confirmed) pauseAckRetry(pendingInboxDelivery);
      if (!pendingInterrupt) pendingInterrupt = { generation: runtimeGeneration, attempts: 0 };
    }
    agentLoopActive = false;
    if (!teamName) {
      if (aborted) {
        locallyInterrupted = false;
        clearPendingInterrupt();
      }
      return;
    }

    const releaseInterruptIfLeaseLost = async () => {
      const current = await runtime.readRuntimeStatus(teamName!, agentName);
      if (!current || current.instanceId !== runtimeInstanceId || current.activity === "stopped") {
        locallyInterrupted = false;
      }
    };

    try {
      const lease = await runtime.readRuntimeStatus(teamName, agentName);
      // Stopped and replacement leases win over a late settlement, including
      // one that already observed aborted=true.
      if (!lease || lease.instanceId !== runtimeInstanceId || lease.activity === "stopped") {
        if (aborted) {
          locallyInterrupted = false;
          clearPendingInterrupt();
        }
        return;
      }

      if (aborted || locallyInterrupted) {
        if (!pendingInterrupt) pendingInterrupt = { generation: runtimeGeneration, attempts: 0 };
        await publishInterrupted();
        // Metadata repair only. Do not read, inject, or acknowledge mail, and
        // do not notify the lead or change task ownership.
        return;
      }

      if (!settleCommitAllowed()) return;
      if (resume) {
        // Only this direct run can repair a persisted interruption. If another
        // attempt still owns the lock, its finally retries the new settled target.
        // Detached recovery is metadata-only, not an idle notification replay.
        await publishResumedActivity(resume);
      } else {
        const hasUnreadWork = (await messaging.readInbox(teamName, agentName, true, false)).length > 0;
        await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
          activity: hasUnreadWork ? "queued" : "idle",
          pid: process.pid,
          processStartToken,
          lastHeartbeatAt: Date.now(),
          lastError: undefined,
        }, ROUTINE_SETTLE_ACTIVITIES, settleCommitAllowed);
      }

    } catch (error) {
      // Never let a settlement error rewrite an interruption or a lost/stopped
      // lease into idle. Ordinary failures may still record idle for a live lease.
      if (aborted || locallyInterrupted) {
        if (!pendingInterrupt) pendingInterrupt = { generation: runtimeGeneration, attempts: 0 };
        await publishInterrupted().catch(() => undefined);
        await releaseInterruptIfLeaseLost().catch(() => undefined);
        return;
      }
      // A resume repair retains its own retry even if settlement's lease/read
      // fails. Do not replace that intent with a routine idle fallback.
      if (resume) {
        scheduleResumeRetry(resume);
        return;
      }
      await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        activity: "idle",
        lastError: runtime.createRuntimeError(error),
      }, ROUTINE_SETTLE_ACTIVITIES, settleCommitAllowed).catch(() => undefined);
    }
  }

  pi.on("session_shutdown", async (event) => {
    const wasPaused = locallyInterrupted;
    const reloading = event?.reason === "reload";
    // Block injection before the first await, same as an aborted settlement.
    sessionStopping = true;
    runtimeGeneration += 1;
    agentLoopActive = false;
    locallyInterrupted = false;
    clearPendingInterrupt();
    clearPendingResume();
    clearPendingInboxDelivery();
    // Best-effort durable cleanup before this process ends; a failure is not
    // fatal because a replacement lead instance drops the stale acceptance.
    if (pendingInspectionRelease) await attemptInspectionRelease(true).catch(() => undefined);
    clearPendingInspectionRelease();
    stopInboxPolling();
    if (!teamName) return;
    if (reloading) {
      // The process stays alive and its new extension instance re-claims this
      // lease. Peers must not see it as stopped (duplicate restore, false
      // quiescence fault, early no_active_agents).
      await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        reloading: true,
        reloadingSince: Date.now(),
        ...(wasPaused ? { paused: true } : {}),
        lastHeartbeatAt: Date.now(),
      }).catch(() => undefined);
      return;
    }
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      activity: "stopped",
      detached: true,
      ...(wasPaused ? { paused: true } : {}),
      pid: process.pid,
      processStartToken,
      lastHeartbeatAt: Date.now(),
    });
    // File-only check. Do not inject into this stopping session.
    await admitQuiescenceInspection(teamName, { isMemberAlive }).catch(() => undefined);
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

  /** Only the lead conversation that currently owns this team's runtime lease. */
  async function assertLiveLead(requested: string, action: "close" | "shut down" | "resume" | "change a teammate model"): Promise<void> {
    if (isTeammate) {
      throw new Error(action === "close"
        ? "Only the team lead can close team panes"
        : action === "shut down"
          ? "Only the team lead can shut down an entire team"
          : action === "resume"
            ? "Only the team lead can resume team panes"
            : "Only the team lead can change a teammate model");
    }
    const owned = !!teamName && teamName === requested && !!identity
      && identity.id && identity.file;
    const status = owned ? await runtime.readRuntimeStatus(requested, "team-lead") : null;
    const config = owned ? await teams.readConfig(requested).catch(() => null) : null;
    const lead = config?.members.find(member => member.agentType === "lead" || member.name === "team-lead");
    const sameConversation = !!lead?.session && lead.session.id === identity?.id && lead.session.file === identity?.file;
    const liveLease = !!status && status.instanceId === runtimeInstanceId && !status.detached
      && status.activity !== "stopped" && runtime.isRuntimeProcessAlive(status)
      && status.sessionId === identity?.id && status.sessionFile === identity?.file;
    if (!owned || !sameConversation || !liveLease) {
      throw new Error(`Only the live lead of ${requested} can ${action} it`);
    }
  }

  function requireCloseableTerminal(action: "close" | "shut down"): void {
    if (terminalClosesProcesses(terminal)) return;
    const which = terminal?.name === "zellij" ? "Zellij" : "Windows Terminal";
    throw new Error(`${which} cannot close teammate panes, so /team-${action === "close" ? "close" : "shutdown"} did not change this team. No member was marked stopped.`);
  }

  /** Fail a launch that has not registered yet. Pane and window ids come from this locked record, not an earlier snapshot. */
  async function invalidatePendingLaunch(team: string, memberName: string, action: "close" | "shut down"): Promise<{ cancelled: boolean; pane?: string; windowId?: string; phase?: "reserved" | "launched" }> {
    const configFile = paths.configPath(team);
    return withLock(configFile, async () => {
      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { members: Member[] };
      const member = config.members.find(item => item.name === memberName);
      const phase = member?.recovery?.phase;
      if (!member?.recovery || phase === "attached" || phase === "failed") return { cancelled: false };
      // A launch can appear after the preflight. Refuse before the durable failure write.
      if (!terminalClosesProcesses(terminal)) requireCloseableTerminal(action);
      const pane = phase === "launched" && member.tmuxPaneId ? member.tmuxPaneId : undefined;
      const windowId = phase === "launched" && member.windowId ? member.windowId : undefined;
      member.recovery.phase = "failed";
      member.recovery.error = "closed before the restored session registered";
      atomicWriteJsonSync(configFile, config);
      return { cancelled: true, pane, windowId, phase };
    });
  }

  /** Put a pending launch back when the terminal close did not succeed, so a later close can retry. */
  async function restorePendingLaunch(team: string, memberName: string, phase: "reserved" | "launched"): Promise<void> {
    const configFile = paths.configPath(team);
    await withLock(configFile, async () => {
      if (!fs.existsSync(configFile)) return;
      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { members: Member[] };
      const member = config.members.find(item => item.name === memberName);
      if (member?.recovery?.phase !== "failed") return;
      if (member.recovery.error !== "closed before the restored session registered") return;
      member.recovery.phase = phase;
      delete member.recovery.error;
      atomicWriteJsonSync(configFile, config);
    });
  }

  async function memberIsRunning(team: string, member: Member): Promise<boolean> {
    const status = await runtime.readRuntimeStatus(team, member.name);
    return !!status && !status.detached && status.activity !== "stopped"
      && runtime.isRuntimeProcessAlive(status);
  }

  function stopNoticePath(team: string): string {
    return path.join(paths.teamDir(team), "stop-notices.json");
  }

  function teamAcceptsWrites(team: string): boolean {
    return dissolvingTeam !== team && fs.existsSync(paths.configPath(team));
  }

  async function updateStopNotices(team: string, update: (state: { expected: string[]; notified: string[] }) => void): Promise<void> {
    const file = stopNoticePath(team);
    await withLock(file, async () => {
      if (!teamAcceptsWrites(team)) return;
      let state = { expected: [] as string[], notified: [] as string[] };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        state = {
          expected: Array.isArray(parsed.expected) ? parsed.expected.filter((id: unknown) => typeof id === "string") : [],
          notified: Array.isArray(parsed.notified) ? parsed.notified.filter((id: unknown) => typeof id === "string") : [],
        };
      } catch {
        // First notice for this team.
      }
      if (!teamAcceptsWrites(team)) return;
      update(state);
      state.expected = state.expected.slice(-200);
      state.notified = state.notified.slice(-200);
      atomicWriteJsonSync(file, state);
    });
  }

  async function expectStop(team: string, instanceId: string): Promise<void> {
    await updateStopNotices(team, state => {
      if (!state.expected.includes(instanceId)) state.expected.push(instanceId);
    });
  }

  async function clearExpectedStop(team: string, instanceId: string): Promise<void> {
    await updateStopNotices(team, state => {
      state.expected = state.expected.filter(id => id !== instanceId);
    });
  }

  async function markStopKnown(team: string, instanceId: string): Promise<void> {
    await updateStopNotices(team, state => {
      state.expected = state.expected.filter(id => id !== instanceId);
      if (!state.notified.includes(instanceId)) state.notified.push(instanceId);
    });
  }

  /** One ordinary inbox note when a known instance stops or its tmux pane disappears. Command closes are expected, not this path. */
  async function reportUnexpectedStops(team: string): Promise<void> {
    const previous = stopReportTail;
    let releaseTail: () => void = () => {};
    stopReportTail = new Promise<void>(resolve => { releaseTail = resolve; });
    try {
      await previous;
      if (!teamAcceptsWrites(team)) return;
      await deliverUnexpectedStopNotices(team);
    } finally {
      releaseTail();
    }
  }

  async function drainStopReports(): Promise<void> {
    let pending = stopReportTail;
    for (;;) {
      await pending;
      if (stopReportTail === pending) return;
      pending = stopReportTail;
    }
  }

  async function deliverUnexpectedStopNotices(team: string): Promise<void> {
    const config = await teams.readConfig(team).catch(() => null);
    if (!config || !teamAcceptsWrites(team)) return;
    const losses: { id: string; text: string }[] = [];
    for (const member of config.members) {
      if (member.agentType === "lead" || member.name === "team-lead") continue;
      const status = await runtime.readRuntimeStatus(team, member.name);
      if (!status?.instanceId || status.reloading) continue;
      const processAlive = !status.detached && status.activity !== "stopped" && runtime.isRuntimeProcessAlive(status);
      const paneChecked = !!(member.tmuxPaneId && terminal);
      const paneMissing = paneChecked && !terminal!.isAlive(member.tmuxPaneId!);
      const confirmedDead = status.detached === true || status.activity === "stopped" || !runtime.isRuntimeProcessAlive(status);
      if (processAlive && !paneMissing) continue;
      if (!confirmedDead && !paneMissing) continue;
      const text = paneMissing && processAlive
        ? `${member.name} pane is missing; the process is still recorded as alive. The session stays on the roster and is not restarted.`
        : paneMissing
          ? `${member.name} stopped and its pane is missing. The session stays on the roster. Tasks are unchanged and it is not restarted.`
          : paneChecked
            ? `${member.name} stopped. The session stays on the roster. Tasks are unchanged and it is not restarted.`
            : `${member.name} stopped. The session stays on the roster. Tasks are unchanged and it is not restarted. Its pane was not checked.`;
      losses.push({ id: status.instanceId, text });
    }
    if (losses.length === 0 || !teamAcceptsWrites(team)) return;
    const file = stopNoticePath(team);
    const claimed: { id: string; text: string }[] = [];
    await withLock(file, async () => {
      if (!teamAcceptsWrites(team)) return;
      let current = { expected: [] as string[], notified: [] as string[] };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        current = {
          expected: Array.isArray(parsed.expected) ? parsed.expected.filter((id: unknown) => typeof id === "string") : [],
          notified: Array.isArray(parsed.notified) ? parsed.notified.filter((id: unknown) => typeof id === "string") : [],
        };
      } catch {
        // First notice for this team.
      }
      if (!teamAcceptsWrites(team)) return;
      for (const loss of losses) {
        if (current.expected.includes(loss.id) || current.notified.includes(loss.id)) continue;
        current.notified.push(loss.id);
        claimed.push(loss);
      }
      if (claimed.length === 0) return;
      current.notified = current.notified.slice(-200);
      atomicWriteJsonSync(file, current);
    });
    const delivered: string[] = [];
    try {
      for (const loss of claimed) {
        if (!teamAcceptsWrites(team)) break;
        const stored = await messaging.appendMessageOnce(team, "team-lead", {
          id: `stop:${loss.id}`,
          from: "pi-teams",
          text: loss.text,
          timestamp: messaging.nowIso(),
          read: false,
          summary: loss.text.slice(0, 80),
        }, () => teamAcceptsWrites(team));
        if (!stored) {
          if (!teamAcceptsWrites(team)) break;
          throw new Error(`stop notice for ${loss.id} was not stored`);
        }
        delivered.push(loss.id);
      }
    } catch (error) {
      const failed = claimed.filter(loss => !delivered.includes(loss.id)).map(loss => loss.id);
      if (failed.length > 0 && teamAcceptsWrites(team)) {
        await withLock(file, async () => {
          if (!teamAcceptsWrites(team)) return;
          let current = { expected: [] as string[], notified: [] as string[] };
          try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            current = {
              expected: Array.isArray(parsed.expected) ? parsed.expected.filter((id: unknown) => typeof id === "string") : [],
              notified: Array.isArray(parsed.notified) ? parsed.notified.filter((id: unknown) => typeof id === "string") : [],
            };
          } catch {
            return;
          }
          const failedIds = new Set(failed);
          current.notified = current.notified.filter(id => !failedIds.has(id));
          if (!teamAcceptsWrites(team)) return;
          atomicWriteJsonSync(file, current);
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async function resolveCloseTarget(args: string): Promise<{ team: string; member?: string }> {
    const token = paths.sanitizeName(args.trim());
    if (!token) {
      if (!teamName) throw new Error("Not attached to a team; usage: /team-close [teammate]");
      return { team: teamName };
    }
    if (teamName) {
      const config = await teams.readConfig(teamName).catch(() => null);
      const member = config?.members.find(item => item.name === token && item.agentType !== "lead" && item.name !== "team-lead");
      if (member) return { team: teamName, member: member.name };
    }
    return { team: token };
  }

  function resolveShutdownTarget(args: string): string {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.at(-1) !== "confirm") {
      throw new Error("Refusing to delete the team without confirmation. Usage: /team-shutdown confirm");
    }
    const name = parts.length === 1 ? teamName : paths.sanitizeName(parts[0] ?? "");
    if (!name || parts.length > 2) throw new Error("Usage: /team-shutdown confirm");
    return name;
  }

  function closeStillOpen(lines: string[]): string[] {
    return lines.filter(line => line.endsWith(": lease changed") || line.endsWith(": close failed"));
  }

  async function performClose(team: string, member: string | undefined, ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }; shutdown: () => void }): Promise<string[]> {
    await assertLiveLead(team, "close");
    const lines = await closeTeammatePanes(team, "close", member);
    const unfinished = closeStillOpen(lines);
    if (member) {
      ctx.ui.notify([
        `Teammate ${member} close result (membership preserved):`,
        ...lines,
        "The lead stays attached. Reopen this member later with /team-resume.",
      ].join("\n"), "info");
      return lines;
    }
    if (unfinished.length > 0) {
      const reasons = [
        unfinished.some(line => line.endsWith(": lease changed"))
          ? "A teammate pane was not closed because its runtime lease changed."
          : "",
        unfinished.some(line => line.endsWith(": close failed"))
          ? "A teammate pane was not closed because the terminal close failed."
          : "",
        "Lead Pi will not exit.",
      ].filter(Boolean);
      ctx.ui.notify([
        `Team ${team} was not fully closed; the lead stays attached:`,
        ...lines,
        ...reasons,
      ].join("\n"), "info");
      return lines;
    }
    ctx.ui.notify([
      `Team ${team} teammate panes closed (data preserved):`,
      ...lines,
      "Lead Pi will exit to its shell; the lead pane stays.",
    ].join("\n"), "info");
    if (sessionStopping) throw new Error("Lead Pi could not exit because the session is already detaching");
    ctx.shutdown();
    return lines;
  }

  async function performResume(team: string, member: string | undefined): Promise<string> {
    await assertLiveLead(team, "resume");
    if (member) {
      const config = await teams.readConfig(team);
      if (!config.members.some(item => item.name === member && item.agentType !== "lead" && item.name !== "team-lead")) {
        throw new Error(`No teammate named ${member}`);
      }
    }
    recoveryOutcomes = await restoreTeamPanes({ team, leaderInstanceId: runtimeInstanceId,
      terminal, piBinary: getPiLaunchCommand(), anchorPaneId: process.env.TMUX_PANE,
      members: member ? [member] : undefined,
      current: () => !sessionStopping });
    return recoveryOutcomes.map(item => `${item.name}: ${item.status}${item.note ? ` — ${item.note}` : ""}`).join("\n") || "No missing roster members.";
  }

  /** Close live teammates and cancel pane launches that have not registered. Lead pane stays. */
  async function closeTeammatePanes(team: string, action: "close" | "shut down" = "close", only?: string): Promise<string[]> {
    const config = await teams.readConfig(team);
    let teammates = config.members.filter(member => member.agentType !== "lead" && member.name !== "team-lead");
    if (only) {
      teammates = teammates.filter(member => member.name === only);
      if (teammates.length === 0) throw new Error(`No teammate named ${only}`);
    }
    let needsTerminal = false;
    for (const member of teammates) {
      const phase = member.recovery?.phase;
      const pending = !!phase && phase !== "attached" && phase !== "failed";
      if (pending || await memberIsRunning(team, member)) { needsTerminal = true; break; }
    }
    if (needsTerminal) requireCloseableTerminal(action);
    const lines: string[] = [];
    for (const member of teammates) {
      const fresh = (await teams.readConfig(team)).members.find(item => item.name === member.name) ?? member;
      const phase = fresh.recovery?.phase;
      const pendingNow = !!phase && phase !== "attached" && phase !== "failed";
      const runningNow = await memberIsRunning(team, fresh);
      if ((pendingNow || runningNow) && !terminalClosesProcesses(terminal)) {
        requireCloseableTerminal(action);
      }
      const prior = await runtime.readRuntimeStatus(team, member.name);
      const instanceId = prior?.instanceId;
      if (instanceId && (pendingNow || runningNow)) await expectStop(team, instanceId);
      const pending = await invalidatePendingLaunch(team, member.name, action);
      if (pending.cancelled) {
        let failed = false;
        if (terminal) {
          if (pending.windowId && terminal.killWindow(pending.windowId) === "failed") failed = true;
          if (pending.pane && terminal.kill(pending.pane) === "failed") failed = true;
        }
        if (failed) {
          if (pending.phase) await restorePendingLaunch(team, member.name, pending.phase);
          if (instanceId) await clearExpectedStop(team, instanceId);
          lines.push(`${member.name}: close failed`);
        } else {
          lines.push(`${member.name}: closed`);
        }
        continue;
      }
      const current = (await teams.readConfig(team)).members.find(item => item.name === member.name) ?? fresh;
      if (!(await memberIsRunning(team, current))) {
        if (instanceId) await markStopKnown(team, instanceId);
        lines.push(`${current.name}: not running`);
        continue;
      }
      if (!terminalClosesProcesses(terminal)) requireCloseableTerminal(action);
      const outcome = await killTeammate(team, current);
      if (outcome !== "closed" && instanceId) await clearExpectedStop(team, instanceId);
      lines.push(`${current.name}: ${outcome === "closed" ? "closed" : outcome === "lease-changed" ? "lease changed" : "close failed"}`);
    }
    return lines;
  }

  async function killTeammate(teamName: string, member: Member): Promise<"closed" | "lease-changed" | "close-failed"> {
    if (member.name === "team-lead") return "closed";

    const prior = await runtime.readRuntimeStatus(teamName, member.name);
    let runtimeStatus = prior;
    if (runtimeStatus?.instanceId) {
      const replaced = await runtime.replaceRuntimeInstance(teamName, member.name, runtimeStatus.instanceId, undefined, {
        activity: "stopped",
        lastHeartbeatAt: Date.now(),
      });
      if (!replaced) return "lease-changed";
      runtimeStatus = replaced;
    } else {
      runtimeStatus = await runtime.setRuntimeActivity(teamName, member.name, "stopped", {
        lastHeartbeatAt: Date.now(),
      });
    }

    const restorePriorRuntime = async () => {
      if (!prior) return;
      if (prior.instanceId) {
        // The stopped write cleared instanceId. undefined matches that released lease.
        await runtime.replaceRuntimeInstance(teamName, member.name, undefined, prior.instanceId, {
          activity: prior.activity,
          activityChangedAt: prior.activityChangedAt,
          detached: prior.detached ?? false,
          paused: prior.paused ?? false,
          lastHeartbeatAt: prior.lastHeartbeatAt ?? Date.now(),
        });
      } else {
        await runtime.setRuntimeActivity(teamName, member.name, prior.activity, {
          activityChangedAt: prior.activityChangedAt,
          detached: prior.detached ?? false,
          paused: prior.paused ?? false,
          lastHeartbeatAt: prior.lastHeartbeatAt ?? Date.now(),
        });
      }
    };

    try {
      const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
      if (fs.existsSync(pidFile)) {
        let parsedPid: number | undefined;
        try {
          parsedPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        } catch {
          // A pid-file read failure skips the signal. The pane close below still runs.
        }
        // Only a successful lease transition and a confirmed process identity may
        // authorize an intentional-stop marker. Do not mark unrelated processes or
        // swallow marker errors as if this shutdown succeeded.
        if (parsedPid !== undefined && runtimeStatus?.pid === parsedPid && runtime.hasConfirmedProcessIdentity(runtimeStatus)) {
          if (member.windowId) terminal?.prepareShutdown?.(member.windowId);
          if (member.tmuxPaneId) terminal?.prepareShutdown?.(member.tmuxPaneId);
          try {
            process.kill(parsedPid, "SIGKILL");
          } catch {
            // The process may have exited after the identity check.
          }
        }
        fs.rmSync(pidFile, { force: true });
      }

      let failed = false;
      if (member.windowId && terminal && terminal.killWindow(member.windowId) === "failed") failed = true;
      if (member.tmuxPaneId && terminal && terminal.kill(member.tmuxPaneId) === "failed") failed = true;
      if (failed) {
        await restorePriorRuntime();
        return "close-failed";
      }
      return "closed";
    } catch (error) {
      await restorePriorRuntime().catch(() => undefined);
      throw error;
    }
  }

  function isMemberAlive(team: string, member: Member, runtimeStatus?: runtime.AgentRuntimeStatus | null): boolean {
    if (member.session) return !!runtimeStatus && !runtimeStatus.detached
      && runtimeStatus.sessionId === member.session.id && runtimeStatus.sessionFile === member.session.file
      && runtime.isRuntimeProcessAlive(runtimeStatus);
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
      reloading: !!runtimeStatus?.reloading,
      reloadingSince: runtimeStatus?.reloadingSince,
      model: member.model,
      thinking: member.thinking,
      modelThinkingSource: "spawn-time hints; current/restored Pi session can differ",
      recoveryOutcome: recoveryOutcomes.find(item => item.name === member.name),
      awaitingConfirmation: runtimeStatus?.inboxAwaitingConfirmation,
      session: member.session ? { id: member.session.id, confirmed: member.session.confirmed } : undefined,
      recovery: member.recovery,
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

  function spawnEnvironment(team: string, agent: string, session?: Member["session"]): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string>, PI_TEAM_NAME: team, PI_AGENT_NAME: agent };
    delete env.PI_SESSION_ID; delete env.PI_SESSION_FILE;
    delete env.PI_TEAM_HANDOFF_TOKEN; delete env.PI_TEAM_RECOVERY_TOKEN;
    if (session?.agentDir) env.PI_CODING_AGENT_DIR = session.agentDir;
    return env;
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

    if (sessionStopping) throw new Error("Session detached before teammate launch");
    const reserved = (await teams.readConfig(safeTeamName)).members.find(m => m.name === safeName);
    const piCmd = buildPiCommand(getPiLaunchCommand(), chosenModel, thinking, undefined, reserved?.session?.file);
    const env = spawnEnvironment(safeTeamName, safeName, reserved?.session);

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

    if (!reserved?.session) throw new Error("Member has no reserved Pi session");
    return launchReservedMember({ team: safeTeamName, agent: safeName, session: reserved.session,
      ownerInstanceId: runtimeInstanceId, terminal, separateWindow: useSeparateWindow,
      options: { name: safeName, cwd, command: piCmd, env, anchorPaneId, teamName: safeTeamName },
      current: () => !sessionStopping, authority: teamName ? { team: teamName, agent: agentName } : undefined });
  }

  function delegatedTaskPrompt(task: any, prompt: string | undefined): string {
    return [
      `You have been assigned task ${task.id}: ${task.subject}`,
      "",
      task.description,
      prompt ? `\nAdditional instructions:\n${prompt}` : "",
    ].filter(Boolean).join("\n");
  }

  // team_create and a mid-turn attach happen after agent_start, which returned
  // early because this process was not on a team yet. The claim records idle.
  // Repair that to running while this turn is still in progress.
  async function publishInFlightTurn(): Promise<void> {
    if (!teamName || !agentLoopActive || locallyInterrupted || sessionStopping) return;
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      activity: "running",
      paused: false,
      pid: process.pid,
      processStartToken,
      lastHeartbeatAt: Date.now(),
      lastError: undefined,
    }, ["idle", "starting", "queued"]);
  }

  async function attachCreatedTeam(name: string, ctx: any): Promise<void> {
    identity = sessionIdentity(ctx) ?? identity;
    if (!identity) throw new Error("A persistent Pi session is required to create a recoverable team");
    await teams.updateMember(name, "team-lead", { session: identity, cwd: identity.cwd });
    await claimSession({ team: name, agent: "team-lead", identity, instanceId: runtimeInstanceId,
      pid: process.pid, processStartToken, paneId: process.env.TMUX_PANE, current: () => !sessionStopping });
    if (sessionStopping) throw new Error("Session changed while creating the team");
    teamName = name;
    startInboxPolling();
    await publishInFlightTurn();
  }

  // Tools
  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a new agent team. Omit default_model to preserve configured teammate defaults; supply it only when the user explicitly requests a team-wide model override, never based on task difficulty.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Optional team-wide model override (provider/model). Omit to use configured teammate defaults. Supply only when the user explicitly requests this override, not based on task difficulty." })),
      separate_windows: Type.Optional(Type.Boolean({ default: false, description: "Open teammates in separate OS windows instead of panes" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (teamName) {
        throw new Error(`This lead session is already bound to team ${teamName}; shut it down before creating another team`);
      }
      if (teams.teamExists(params.team_name)) {
        throw new Error(`Team ${params.team_name} already exists; resume its original Pi session (data preserved)`);
      }
      identity = sessionIdentity(ctx) ?? identity;
      if (!identity) throw new Error("A persistent Pi session is required to create a recoverable team");
      
      if (findSessionMember(identity)) throw new Error("This conversation already has a team/member binding");
      const config = await teams.createTeam(params.team_name, identity.id, "lead-agent", params.description, params.default_model, params.separate_windows);
      await attachCreatedTeam(params.team_name, ctx);
      return {
        content: [{ type: "text", text: `Team ${params.team_name} created.` }],
        details: { config },
      };
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Create a task, assign it to a teammate, and spawn or reuse that teammate as needed. This is the formal dispatch boundary: it arms the team quiescence fallback for new or follow-up work. For new teammates, omit model and thinking to use configured teammate defaults. Supply either only when the user explicitly requests that override; never choose overrides based on task difficulty. Reusing a live teammate does not change its model or thinking.",
    parameters: Type.Object({
      team_name: Type.String(),
      teammate_name: Type.String(),
      cwd: Type.String(),
      task_subject: Type.String(),
      task_description: Type.String(),
      prompt: Type.Optional(Type.String({ description: "Additional teammate instructions for this task." })),
      model: Type.Optional(Type.String({ description: "Optional model override (provider/model) for a new teammate. Omit to use the team defaultModel, then settings teammateDefaultProvider/teammateDefaultModel. Supply only when the user explicitly requests a model override, not based on task difficulty. Does not change a live reused teammate." })),
      thinking: Type.Optional(StringEnum([...THINKING_LEVELS], { description: "Optional thinking-level override for a new teammate. Omit to use settings teammateDefaultThinkingLevel. Supply only when the user explicitly requests a thinking override, not based on task difficulty. Does not change a live reused teammate." })),
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
      const restoreExisting = !!member && reuse === "existing" && !memberAlive;
      const willSpawn = !member || reuse === "replace";
      if (restoreExisting && member?.recovery && ["reserved", "launched"].includes(member.recovery.phase)) {
        throw new Error("Original member launch is still unconfirmed; not replacing its session or duplicating it");
      }
      const requestedSeparateWindow = params.separate_window ?? teamConfig.separateWindows ?? false;

      if (member && reuse === "error") {
        throw new Error(`Teammate ${safeName} already exists in team ${safeTeamName}`);
      }

      if (member && reuse === "existing" && member.cwd && path.resolve(member.cwd) !== path.resolve(params.cwd)) {
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

      if (member && reuse === "replace") {
        const outcome = await killTeammate(safeTeamName, member);
        if (outcome === "lease-changed") {
          throw new Error(`Teammate ${safeName} lease changed during replacement; the original member was left in place and was not replaced.`);
        }
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
          session: allocateSession(safeTeamName, params.cwd),
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
          if ((error as { mayHaveLaunched?: boolean }).mayHaveLaunched) {
            await openFormalGeneration(safeTeamName);
            throw new Error(`Launch unconfirmed for ${safeName}; task ${task.id}, inbox and original session retained. ${String(error)}`);
          }
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

      const restoreOutcome = restoreExisting ? (await restoreTeamPanes({ team: safeTeamName,
        leaderInstanceId: runtimeInstanceId, terminal, piBinary: getPiLaunchCommand(),
        anchorPaneId: process.env.TMUX_PANE, members: [safeName], current: () => !sessionStopping }))[0] : undefined;
      // Restoration itself does not arm a generation; this new assignment does,
      // even if its original-session pane recovery is blocked.
      await openFormalGeneration(safeTeamName);

      return {
        content: [{
          type: "text",
          text: `Task ${task.id} delegated to ${safeName}${spawned ? ` in ${isWindow ? "window" : "pane"} ${terminalId}` : ""}.${restoreOutcome ? ` Original-session recovery: ${restoreOutcome.status} — ${restoreOutcome.note ?? ""}` : ""}`,
        }],
        details: { task: assigned, teammate: member, spawned, terminalId, isWindow, restoreOutcome },
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
      const handoffSession = allocateSession(safeTeamName, cwd);
      const piCmd = buildPiCommand(getPiLaunchCommand(), teamConfig.defaultModel, undefined, undefined, handoffSession.file);

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
        () => !sessionStopping,
      );
      if (!placeholder) {
        throw new Error("This lead session no longer owns the active runtime lease");
      }
      stopInboxPolling();

      const env = { ...spawnEnvironment(safeTeamName, "team-lead", handoffSession), PI_TEAM_HANDOFF_TOKEN: handoffToken };
      const updateHandoffMember = (updates: Partial<Member>, expectedId: string | undefined) => withLock(paths.configPath(safeTeamName), async () => {
        const config = JSON.parse(fs.readFileSync(paths.configPath(safeTeamName), "utf8"));
        const lead = config.members.find((item: Member) => item.name === "team-lead");
        if (sessionStopping || !lead || lead.session?.id !== expectedId) throw new Error("handoff binding was superseded");
        Object.assign(lead, updates);
        if (updates.session) config.leadSessionId = updates.session.id;
        atomicWriteJsonSync(paths.configPath(safeTeamName), config);
      });
      try {
        await updateHandoffMember({ session: handoffSession }, identity?.id);
        const windowId = await withLock(paths.runtimeStatusPath(safeTeamName, agentName), async () => {
          const lease = runtime.readRuntimeStatusSync(safeTeamName, agentName);
          if (sessionStopping || lease?.instanceId !== handoffToken || lease.activity !== "starting") throw new Error("handoff authority lost before launch");
          return terminal.spawnWindow({ name: "team-lead", cwd, command: piCmd, env, teamName: safeTeamName });
        });
        await updateHandoffMember({ windowId }, handoffSession.id);
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
          () => !sessionStopping,
        ).catch(() => null);
        if (restored) {
          await updateHandoffMember({ session: identity }, handoffSession.id);
          startInboxPolling();
        } else {
          teamName = null;
          ctx.ui.setStatus("pi-teams", undefined);
          if (!sessionStopping) setTimeout(() => ctx.shutdown(), 0);
        }
        throw new Error(`Failed: ${e}`);
      }
    }
  });

  pi.registerTool({
    name: "team_message",
    label: "Team Message",
    description: "Send a message to one teammate, the lead, or everyone on the team. Delivery does not resume an interrupted session; that mail stays unread until a direct user prompt in the recipient session.",
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
    description: "Block until this member receives a team message, no other live member can make progress, an optional timeout expires, or the call is aborted. A live interrupted peer is not progress-capable and does not auto-resume, but it keeps an indefinite wait open until it resumes, stops, or its process dies. The default is an indefinite wait.",
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
      }, ["running", "idle"]);
      if (!enteredWait) {
        const current = await runtime.readRuntimeStatus(safeTeamName, agentName);
        if (!current || current.instanceId !== runtimeInstanceId) {
          throw new Error(`Agent ${agentName} no longer owns the active runtime lease for team ${safeTeamName}`);
        }
        throw new Error(`Agent ${agentName} cannot enter team_wait from activity ${current.activity}`);
      }

      try {
        const result = await waitForTeam({
          timeoutSeconds: params.timeout_seconds,
          signal,
          consumeMessages: async () => {
            if (signal?.aborted) throw waitAbort();
            const lease = await runtime.updateRuntimeStatusForInstance(
              safeTeamName,
              agentName,
              runtimeInstanceId,
              { lastHeartbeatAt: Date.now() },
              "waiting",
            );
            if (!lease) throw new Error(`Agent ${agentName} lost its runtime lease while waiting`);
            if (signal?.aborted) throw waitAbort();

            const messages = await messaging.readInbox(safeTeamName, agentName, true, false);
            if (signal?.aborted) throw waitAbort();
            if (messages.length === 0) return [];

            // Commit is the linearization point. Cancellation, pause, shutdown,
            // or lease loss observed after the inbox lock is acquired leaves
            // the mail unread. A commit that succeeds is not undone.
            const marked = await messaging.commitInboxAcknowledgement(
              safeTeamName,
              agentName,
              messages.map(message => message.id),
              (status) => !signal?.aborted
                && !locallyInterrupted
                && !sessionStopping
                && status?.instanceId === runtimeInstanceId
                && status.activity === "waiting",
            );
            if (marked === 0) {
              if (signal?.aborted) throw waitAbort();
              throw new Error(`Agent ${agentName} lost its runtime lease before inbox delivery`);
            }
            await runtime.updateRuntimeStatusForInstance(safeTeamName, agentName, runtimeInstanceId, {
              lastInboxReadAt: Date.now(),
              lastHeartbeatAt: Date.now(),
            }, "waiting").catch(() => undefined);
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

  // User command only. The model has no tool that deletes a team.
  async function shutdownTeam(shuttingDownTeamName: string, ctx: any): Promise<{ text: string; cleanedSessions: number }> {
    try {
      await assertLiveLead(shuttingDownTeamName, "shut down");
      const closed = await closeTeammatePanes(shuttingDownTeamName, "shut down");
      const unfinished = closeStillOpen(closed);
      if (unfinished.length > 0) {
        throw new Error(`Team ${shuttingDownTeamName} was not deleted because a teammate pane stayed open: ${closed.join("; ")}`);
      }
      dissolvingTeam = shuttingDownTeamName;
      if (teamName === shuttingDownTeamName) {
        await runtime.updateRuntimeStatusForInstance(shuttingDownTeamName, agentName, runtimeInstanceId, {
          activity: "stopped",
          lastHeartbeatAt: Date.now(),
        }).catch(() => undefined);
        stopInboxPolling();
        teamName = null;
        ctx.ui.setStatus("pi-teams", undefined);
      }
      await drainStopReports();
      const dir = paths.teamDir(shuttingDownTeamName);
      const tasksDir = paths.taskDir(shuttingDownTeamName);
      if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true });
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

      // Clean up orphaned agent session folders (older than 1 hour)
      const cleanedSessions = cleanupAgentSessionFolders(60 * 60 * 1000);

      const text = `Team ${shuttingDownTeamName} shut down. ${closed.join("; ")}.${cleanedSessions > 0 ? ` Cleaned up ${cleanedSessions} orphaned agent session folder(s).` : ""}`;
      return { text, cleanedSessions };
    } catch (e) {
      throw new Error(`Failed to shutdown team: ${e}`);
    }
  }

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
    description: "Check a single teammate's liveness, coordination activity (including interrupted), and unread messages.",
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
    description: "Show team members, task board, and runtime health in one response. Activity interrupted means that session was aborted and will not auto-resume until a direct user prompt. inboxAwaitingConfirmation means host acceptance of those message IDs is unknown, not that delivery failed; this process will not resend them.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const taskList = await tasks.listTasks(params.team_name);
      const members = await Promise.all(config.members.map(member => memberSnapshot(params.team_name, member)));

      const result = { team: config.name, members, tasks: taskList,
        recovery: params.team_name === teamName ? recoveryOutcomes : undefined };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "team_close",
    label: "Close Teammate Panes",
    description: "Close one teammate pane, or every teammate pane, without removing anyone from the roster. Pass agent_name for one member; the lead stays. Omit agent_name to close every teammate and then exit this lead Pi back to its shell when every required pane actually closed. Use only when the user explicitly asks to close panes. Do not call this because a task finished or a member is idle. Closing does not complete tasks and does not delete the team.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const member = params.agent_name ? paths.sanitizeName(params.agent_name) : undefined;
      const lines = await performClose(params.team_name, member || undefined, ctx);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { lines },
      };
    },
  });

  pi.registerTool({
    name: "team_resume",
    label: "Resume Teammate Panes",
    description: "Reopen missing roster sessions for this lead. Pass agent_name to reopen one teammate; omit it to reopen every missing teammate. Uses the original Pi session, does not start a replacement conversation, and does not replay tasks. Use only when the user explicitly asks to reopen panes.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params: any) {
      const member = params.agent_name ? paths.sanitizeName(params.agent_name) : undefined;
      const text = await performResume(params.team_name, member || undefined);
      return {
        content: [{ type: "text", text }],
        details: { recovery: recoveryOutcomes },
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
    description: "Create a team from a predefined team configuration. Spawns all agents defined in the team template from teams.yaml. Each agent is spawned with its predefined prompt, tools, and settings. Successful worker launches arm the team quiescence fallback. Omit default_model to preserve template and configured teammate defaults; supply it only when the user explicitly requests an override, never based on task difficulty.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team instance" }),
      predefined_team: Type.String({ description: "Name of the predefined team template from teams.yaml" }),
      cwd: Type.String({ description: "Working directory for spawned agents" }),
      default_model: Type.Optional(Type.String({ description: "Optional model override (provider/model) for agents without a specified model. Omit to preserve template and configured teammate defaults. Supply only when the user explicitly requests this override, not based on task difficulty." })),
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
      identity = sessionIdentity(ctx) ?? identity;
      if (!identity) throw new Error("A persistent Pi session is required to create a recoverable team");
      if (findSessionMember(identity)) throw new Error("This conversation already has a team/member binding");
      const config = await teams.createTeam(params.team_name, identity.id, "lead-agent", `Predefined team: ${params.predefined_team}`, params.default_model, params.separate_windows);
      await attachCreatedTeam(params.team_name, ctx);

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
            session: allocateSession(safeTeamName, params.cwd),
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

          try {
            await spawnTeammateProcess(safeTeamName, safeName, params.cwd, chosenModel, chosenThinking,
              useSeparateWindow, await teams.readConfig(safeTeamName));
            spawnResults.push({ name: agentName, status: "spawned", error: undefined });
          } catch (e) {
            spawnResults.push({ name: agentName, status: (e as { mayHaveLaunched?: boolean }).mayHaveLaunched ? "launch-unknown" : "error", error: `Failed to confirm spawn; member/session preserved: ${e}` });
          }
        } catch (e) {
          spawnResults.push({ name: agentName, status: "error", error: String(e) });
        }
      }

      const summary = spawnResults.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
      if (spawnResults.some(result => result.status === "spawned" || result.status === "launch-unknown")) {
        await openFormalGeneration(paths.sanitizeName(params.team_name));
      }

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

  return () => {
    // Synchronous invalidation precedes any lock wait during session replacement.
    sessionStopping = true;
    runtimeGeneration += 1;
    stopInboxPolling();
    clearPendingInterrupt();
    clearPendingResume();
    clearPendingInboxDelivery();
    clearPendingInspectionRelease();
    acceptedInspection = undefined;
    inspectionAckPending = false;
  };
}
