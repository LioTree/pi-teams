import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import * as control from "../src/utils/control";
import { classifyTeamWaitPeer, waitForTeam } from "../src/utils/team-wait";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../src/utils/atomic-file";
import { resolveAgentRole } from "../src/utils/agent-role";
import { applyTeamSystemPrompt, buildLeadSystemPrompt, buildTeammateSystemPrompt } from "../src/utils/team-prompts";
import { buildPiCommand } from "../src/utils/pi-command";
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
  // Set synchronously on an aborted settlement so an in-flight poll cannot
  // inject mail before the runtime file publish finishes. Cleared by a new
  // agent run, shutdown, or discovering this process no longer owns a live lease.
  let locallyInterrupted = false;
  let sessionStopping = false;
  // Bumped synchronously when a new run or shutdown supersedes an in-flight
  // interrupted publication, including one still waiting for the runtime lock.
  let runtimeGeneration = 0;
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
  const INTERRUPT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 5000];
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
      const hasUnread = settled && (await messaging.readInbox(teamName, agentName, true, false)).length > 0;
      const activity = settled ? (hasUnread ? "queued" : "idle") : "running";
      if (!commitAllowed()) return null;
      const updated = await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
        activity,
        pid: process.pid,
        processStartToken,
        lastHeartbeatAt: Date.now(),
        lastError: undefined,
      }, INTERRUPTIBLE_ACTIVITIES, commitAllowed, settled ? () => ({
        activity: control.readControlStateSync(teamName!, agentName).mode === "user" ? "idle" : activity,
      }) : undefined);
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
      locallyInterrupted ||
      sessionStopping ||
      !teamName ||
      !sessionCtx?.isIdle()
    ) return;
    const activeTeam = teamName;
    inboxDeliveryInFlight = true;
    try {
      await control.withMemberControl(activeTeam, agentName, async current => {
        if (isTeammate && (current.state.mode === "user" || current.state.instanceId !== runtimeInstanceId)) return;
        const leaseBeforeRead = await runtime.readRuntimeStatus(activeTeam, agentName);
        // Recheck after every await. A mode commit serializes on this control
        // lock; abort, shutdown, and replacement also win at the runtime commit.
        if (locallyInterrupted || sessionStopping || agentLoopActive || !leaseCanDeliver(leaseBeforeRead)) return;

        const unread = await messaging.readInbox(activeTeam, agentName, true, false);
        const leaseAfterRead = await runtime.readRuntimeStatus(activeTeam, agentName);
        if (locallyInterrupted || sessionStopping || agentLoopActive || !sessionCtx.isIdle() || !leaseCanDeliver(leaseAfterRead)) return;

        if (unread.length === 0) {
          if (leaseAfterRead.activity === "queued") {
            await runtime.updateRuntimeStatusForInstance(activeTeam, agentName, runtimeInstanceId,
              { activity: "idle", lastHeartbeatAt: Date.now() }, "queued");
          }
          return;
        }
        if (leaseAfterRead.activity === "idle") await runtime.markRuntimeQueuedIfIdle(activeTeam, agentName);
        const leaseBeforeDelivery = await runtime.readRuntimeStatus(activeTeam, agentName);
        if (locallyInterrupted || sessionStopping || agentLoopActive || !sessionCtx.isIdle() || !leaseCanDeliver(leaseBeforeDelivery)) return;
        const deliveryBatch = unread.slice(0, 1);

        // sendUserMessage returns before acceptance. The control lock makes a
        // mode switch linearize before or after this handoff, never in between.
        // Keep the same unread attempt until matching message_end proof.
        if (locallyInterrupted || sessionStopping || pendingInboxDelivery) return;
        current.assertOwned();
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
      });
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

  function showControlMode(ctx: { ui: { setStatus: (key: string, text: string) => void } }) {
    if (!isTeammate || !teamName || sessionStopping) return;
    const current = control.readControlStateSync(teamName, agentName);
    const lease = runtime.readRuntimeStatusSync(teamName, agentName);
    if (current.instanceId !== runtimeInstanceId || lease?.instanceId !== runtimeInstanceId || lease.activity === "stopped") return;
    // Read fresh at render time: an older async command must never paint its
    // captured mode over a newer switch. Separate from delivery diagnostics.
    ctx.ui.setStatus("pi-teams-control", current.mode === "user"
      ? "Control: USER · leader reports held · /team-mode team"
      : "Control: TEAM · /team-mode user");
  }

  pi.registerCommand("team-mode", {
    description: "Teammate control: /team-mode [team|user|flush]. Show mode, enter user takeover, hand back, or explicitly flush held leader reports.",
    getArgumentCompletions: prefix => {
      const matches = ["team", "user", "flush"].filter(value => value.startsWith(prefix));
      return matches.length ? matches.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      const usage = "/team-mode user: human takeover; /team-mode team: hand back (NOT task complete); /team-mode flush: release held reports without changing mode.";
      if (!isTeammate || !teamName || sessionStopping) {
        ctx.ui.notify(`Unavailable: /team-mode runs only in a live teammate pane, not a lead or unbound session. ${usage}`, "warning");
        return;
      }
      if (action && !["team", "user", "flush"].includes(action)) {
        ctx.ui.notify(`Invalid team mode: ${action}. ${usage}`, "error");
        return;
      }
      try {
        const config = await teams.readConfig(teamName);
        if (!config.members.some(member => member.name === agentName && member.agentType === "teammate")) {
          throw new Error("This session is not a current teammate member of the team.");
        }
        const lease = await runtime.readRuntimeStatus(teamName, agentName);
        if (lease?.instanceId !== runtimeInstanceId || lease.activity === "stopped") {
          throw new Error("This teammate no longer owns a live runtime lease.");
        }
        if (!action) {
          const current = control.controlSnapshot(control.readControlStateSync(teamName, agentName));
          showControlMode(ctx);
          ctx.ui.notify(`Control: ${current.mode.toUpperCase()}; held reports: ${current.heldReports}; held idle: ${current.heldIdle}; release pending: ${current.releasePending}. ${usage}`, "info");
          return;
        }
        const allowed = () => !sessionStopping;
        if (action === "user") {
          await control.enterUserControl(teamName, agentName, runtimeInstanceId, allowed);
        } else {
          await control.releaseControlReports({
            teamName,
            agentName,
            instanceId: runtimeInstanceId,
            action: action as "team" | "flush",
            allow: allowed,
            getSnapshot: async () => {
              const allTasks = await tasks.listTasks(teamName!);
              const status = await runtime.readRuntimeStatus(teamName!, agentName);
              return { activity: status?.activity ?? "unknown", tasks: allTasks, generation: runtimeGeneration, settled: !agentLoopActive };
            },
            getRunState: () => ({ generation: runtimeGeneration, settled: !agentLoopActive }),
          });
        }
        showControlMode(ctx);
        const current = control.readControlStateSync(teamName, agentName);
        if (current.instanceId === runtimeInstanceId && !sessionStopping) {
          ctx.ui.notify(`Control: ${current.mode.toUpperCase()}. ${action === "user" ? "Continue real work here; leader reports and idle inbox auto-start are held. Active explicit team_wait can still consume dependency mail." : "Report release finished. Handback is not task completion and does not resume an interrupted run."}`, "info");
        }
      } catch (error) {
        // A mailbox append may have committed before outbox cleanup failed.
        // Never claim rollback/cancellation; the saved batch ID makes retry safe.
        try { showControlMode(ctx); } catch {}
        ctx.ui.notify(`Team mode operation failed: ${error instanceof Error ? error.message : String(error)}. Undelivered reports remain pending; a saved batch may already be delivered. Inspect /team-mode and retry explicitly.`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    paths.ensureDirs();
    sessionCtx = ctx;

    if (isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
        atomicWriteFileSync(pidFile, process.pid.toString());
        await control.claimMemberControl(teamName, agentName, runtimeInstanceId, () => runtime.setRuntimeActivity(teamName!, agentName, "starting", {
          instanceId: runtimeInstanceId,
          pid: process.pid,
          processStartToken,
          startedAt: Date.now(),
          activityChangedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          lastError: undefined,
          inboxAwaitingConfirmation: undefined,
        }));
        showControlMode(ctx);
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
            inboxAwaitingConfirmation: undefined,
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
          inboxAwaitingConfirmation: undefined,
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
      let settled: runtime.AgentRuntimeStatus | null;
      if (resume) {
        // Only this direct run can repair a persisted interruption. If another
        // attempt still owns the lock, its finally retries the new settled target.
        // Detached recovery is metadata-only, not an idle notification replay.
        settled = await publishResumedActivity(resume);
      } else {
        const hasUnreadWork = (await messaging.readInbox(teamName, agentName, true, false)).length > 0;
        settled = await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
          activity: hasUnreadWork ? "queued" : "idle",
          pid: process.pid,
          processStartToken,
          lastHeartbeatAt: Date.now(),
          lastError: undefined,
        }, ROUTINE_SETTLE_ACTIVITIES, settleCommitAllowed, () => ({
          activity: control.readControlStateSync(teamName!, agentName).mode === "user" ? "idle" : hasUnreadWork ? "queued" : "idle",
        }));
      }

      if (!settled || !settleCommitAllowed() || settled.activity !== "idle" || !isTeammate) return;
      const ownedTasks = (await tasks.listTasks(teamName))
        .filter(task => task.owner === agentName && task.status !== "completed" && task.status !== "deleted")
        .map(task => ({ id: task.id, subject: task.subject, status: task.status }));
      const taskLines = ownedTasks.length > 0
        ? ownedTasks.map(task => `- ${task.id} [${task.status}] ${task.subject}`)
        : ["- none"];
      const stillIdle = await runtime.readRuntimeStatus(teamName, agentName);
      if (!settleCommitAllowed() || stillIdle?.instanceId !== runtimeInstanceId || stillIdle.activity !== "idle") return;
      await messaging.sendPlainMessage(
        teamName,
        agentName,
        "team-lead",
        [`Agent ${agentName} is idle.`, "Owned unfinished tasks:", ...taskLines].join("\n"),
        `${agentName} is idle`,
        undefined,
        { instanceId: runtimeInstanceId, kind: "idle", generation, allow: settleCommitAllowed },
      );
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
  });

  pi.on("session_shutdown", async () => {
    // Block injection before the first await, same as an aborted settlement.
    sessionStopping = true;
    runtimeGeneration += 1;
    agentLoopActive = false;
    locallyInterrupted = false;
    clearPendingInterrupt();
    clearPendingResume();
    clearPendingInboxDelivery();
    stopInboxPolling();
    if (!teamName) return;
    await runtime.updateRuntimeStatusForInstance(teamName, agentName, runtimeInstanceId, {
      activity: "stopped",
      pid: process.pid,
      processStartToken,
      lastHeartbeatAt: Date.now(),
      inboxAwaitingConfirmation: undefined,
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
        controlMode: teamName ? control.readControlStateSync(teamName, agentName).mode : "team",
      }));
    }

    return applyTeamSystemPrompt(event, buildLeadSystemPrompt({
      baseSystemPrompt: "",
      teamName,
    }));
  });

  async function killTeammate(teamName: string, member: Member, heldControl?: control.LockedMemberControl): Promise<void> {
    if (member.name === "team-lead") return;
    if (!heldControl) {
      return control.withMemberControl(teamName, member.name, current => killTeammate(teamName, member, current));
    }

    const runtimeStatus = await runtime.readRuntimeStatus(teamName, member.name);
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

    control.retireMemberControl(heldControl);
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
    const memberControl = control.readControlStateSync(team, member.name);
    const classified = classifyTeamWaitPeer({
      name: member.name,
      agentType: member.agentType,
      alive,
      activity: runtimeStatus?.activity,
      activityChangedAt: runtimeStatus?.activityChangedAt,
      joinedAt: member.joinedAt,
      unreadCount,
      controlMode: memberControl.mode,
    }, Date.now(), runtime.STARTUP_STALL_MS);

    return {
      ...classified,
      liveness: alive ? "alive" as const : "dead" as const,
      model: member.model,
      thinking: member.thinking,
      awaitingConfirmation: runtimeStatus?.inboxAwaitingConfirmation,
      control: control.controlSnapshot(memberControl),
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

      return control.withMemberControl(safeTeamName, safeName, async memberControl => {
      if (memberControl.state.mode === "user") {
        throw new Error(`Teammate ${safeName} is user-controlled. Ask the human to run /team-mode team locally before delegating; no task, process, or model was changed.`);
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
        await killTeammate(safeTeamName, member, memberControl);
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
      });
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
        const delivery = await messaging.broadcastMessage(params.team_name, agentName, params.content, summary, params.color, { instanceId: runtimeInstanceId });
        return {
          content: [{ type: "text", text: `Broadcast: delivered to ${delivery.delivered.join(", ") || "none"}; held for ${delivery.held.join(", ") || "none"}; failed for ${delivery.failed.join(", ") || "none"}.` }],
          details: { to: "all", ...delivery },
        };
      }

      const config = await teams.readConfig(params.team_name);
      if (!config.members.some(m => m.name === params.to)) {
        throw new Error(`Agent ${params.to} is not a member of team ${params.team_name}`);
      }

      const message = await messaging.sendPlainMessage(params.team_name, agentName, params.to, params.content, summary, params.color, { instanceId: runtimeInstanceId });
      return {
        content: [{ type: "text", text: message.delivery === "held"
          ? `Report held for ${params.to} while user-controlled. Use /team-mode flush or /team-mode team locally to release it.`
          : message.delivery === "suppressed" ? "Message was not sent: this operation no longer owns its runtime/control lease."
          : `Message sent to ${params.to}.` }],
        details: { to: params.to, delivery: message.delivery },
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
      }, "running");
      if (!enteredWait) {
        throw new Error(`Agent ${agentName} no longer owns the active runtime lease for team ${safeTeamName}`);
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
                  controlMode: control.readControlStateSync(safeTeamName, member.name).mode,
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
        instanceId: runtimeInstanceId,
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
