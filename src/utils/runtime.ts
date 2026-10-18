import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { runtimeStatusPath, teamDir } from "./paths";
import { atomicWriteJsonSync } from "./atomic-file";

/**
 * Runtime constants for health checking.
 * Exported for configurability and testing.
 */
export const STARTUP_STALL_MS = 60000;   // 60 seconds
export const RUNTIME_STALE_MS = 300000;  // 5 minutes - files older than this are considered stale

export const AGENT_ACTIVITIES = [
  "starting",
  "queued",
  "running",
  "waiting",
  "idle",
  // Live user-aborted pause. Not idle, not stopped, and not subject to
  // startup-grace or staleness deadlines while the process remains alive.
  "interrupted",
  "stopped",
] as const;

export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

/**
 * Structured error information for better diagnostics.
 */
export interface RuntimeError {
  message: string;
  timestamp: number;
}

/** Unknown host acceptance. This is a diagnostic, not a confirmed delivery failure. */
export interface InboxAwaitingConfirmation {
  messageIds: string[];
  since: number;
  note: string;
}

export interface AgentRuntimeStatus {
  teamName: string;
  agentName: string;
  activity: AgentActivity;
  activityChangedAt: number;
  instanceId?: string;
  pid?: number;
  processStartToken?: string;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastInboxReadAt?: number;
  lastError?: RuntimeError;
  inboxAwaitingConfirmation?: InboxAwaitingConfirmation;
  sessionId?: string;
  sessionFile?: string;
  /** A stopped/detached session is not the same as relinquished membership. */
  detached?: boolean;
  /** Retained across shutdown/startup, cleared only by legitimate direct work. */
  paused?: boolean;
  /** Same process is swapping extension code; it stays alive and keeps its activity. */
  reloading?: boolean;
  /** When the reloading marker was written; a stale value means the reload never finished. */
  reloadingSince?: number;
}

type LegacyRuntimeStatus = Partial<AgentRuntimeStatus> & { ready?: boolean };

function isAgentActivity(value: unknown): value is AgentActivity {
  return typeof value === "string" && AGENT_ACTIVITIES.includes(value as AgentActivity);
}

function defaultActivity(status: LegacyRuntimeStatus): AgentActivity {
  // `ready` predates activity tracking. An explicitly-not-ready process is still
  // starting; an old ready (or otherwise live) process is safest treated as
  // running until it publishes a more precise state.
  return status.ready === false ? "starting" : "running";
}

function normalizeRuntimeStatus(
  value: LegacyRuntimeStatus,
  teamName: string,
  agentName: string,
  fallbackTimestamp: number
): { status: AgentRuntimeStatus; changed: boolean } {
  const activity = isAgentActivity(value.activity)
    ? value.activity
    : defaultActivity(value);
  const activityChangedAt = typeof value.activityChangedAt === "number"
    ? value.activityChangedAt
    : value.lastHeartbeatAt ?? value.startedAt ?? fallbackTimestamp;

  const { ready: _legacyReady, ...currentFields } = value;
  const status: AgentRuntimeStatus = {
    ...currentFields,
    teamName,
    agentName,
    activity,
    activityChangedAt,
  };

  return {
    status,
    changed:
      value.teamName !== teamName ||
      value.agentName !== agentName ||
      value.activity !== activity ||
      value.activityChangedAt !== activityChangedAt ||
      "ready" in value,
  };
}

/** Read a runtime file the caller already holds the lock for. Do not lock again. */
export function readRuntimeStatusSync(
  teamName: string,
  agentName: string,
): AgentRuntimeStatus | null {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;
  return readRuntimeFile(p, teamName, agentName)?.status ?? null;
}

function readRuntimeFile(
  p: string,
  teamName: string,
  agentName: string
): { status: AgentRuntimeStatus; changed: boolean } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as LegacyRuntimeStatus;
    const fallbackTimestamp = fs.statSync(p).mtimeMs;
    return normalizeRuntimeStatus(raw, teamName, agentName, fallbackTimestamp);
  } catch {
    return null;
  }
}

function mergeRuntimeStatus(
  current: AgentRuntimeStatus,
  updates: Partial<AgentRuntimeStatus>,
  now = Date.now(),
): AgentRuntimeStatus {
  const requestedActivity = isAgentActivity(updates.activity)
    ? updates.activity
    : current.activity;
  const activityChanged = requestedActivity !== current.activity;

  return {
    ...current,
    ...updates,
    teamName: current.teamName,
    agentName: current.agentName,
    activity: requestedActivity,
    activityChangedAt:
      updates.activityChangedAt ??
      (activityChanged ? now : current.activityChangedAt),
  };
}

/**
 * Write runtime status for an agent. Merges with existing status.
 */
export async function writeRuntimeStatus(
  teamName: string,
  agentName: string,
  updates: Partial<AgentRuntimeStatus>
): Promise<AgentRuntimeStatus> {
  const p = runtimeStatusPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return await withLock(p, async () => {
    const now = Date.now();
    let current: AgentRuntimeStatus = {
      teamName,
      agentName,
      activity: "starting",
      activityChangedAt: now,
    };

    if (fs.existsSync(p)) {
      current = readRuntimeFile(p, teamName, agentName)?.status ?? current;
    }

    const next = mergeRuntimeStatus(current, updates, now);

    atomicWriteJsonSync(p, next);
    return next;
  });
}

/**
 * Update only the runtime lease owned by this Pi session. This prevents a
 * settling or shutting-down old process from overwriting a replacement
 * process that uses the same team member name.
 */
export async function updateRuntimeStatusForInstance(
  teamName: string,
  agentName: string,
  instanceId: string,
  updates: Partial<AgentRuntimeStatus>,
  expectedActivity?: AgentActivity | readonly AgentActivity[],
  // Re-checked after this call has acquired the runtime lock, including when
  // it had to wait. Must not await or take the runtime lock again.
  commitGuard?: (current: AgentRuntimeStatus) => boolean,
): Promise<AgentRuntimeStatus | null> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return null;
    const loaded = readRuntimeFile(p, teamName, agentName);
    if (!loaded || loaded.status.instanceId !== instanceId) return null;

    const expected = expectedActivity === undefined
      ? undefined
      : Array.isArray(expectedActivity) ? expectedActivity : [expectedActivity];
    if (expected && !expected.includes(loaded.status.activity)) return null;
    if (commitGuard && !commitGuard(loaded.status)) return null;

    const next = mergeRuntimeStatus(loaded.status, {
      ...updates,
      instanceId,
    });
    atomicWriteJsonSync(p, next);
    return next;
  });
}

/** Atomically transfer or release a runtime lease. */
export async function replaceRuntimeInstance(
  teamName: string,
  agentName: string,
  expectedInstanceId: string,
  nextInstanceId: string | undefined,
  updates: Partial<AgentRuntimeStatus>,
  expectedActivity?: AgentActivity | readonly AgentActivity[],
  commitGuard?: () => boolean,
): Promise<AgentRuntimeStatus | null> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return null;
    const loaded = readRuntimeFile(p, teamName, agentName);
    if (!loaded || loaded.status.instanceId !== expectedInstanceId || commitGuard && !commitGuard()) return null;

    const expected = expectedActivity === undefined
      ? undefined
      : Array.isArray(expectedActivity) ? expectedActivity : [expectedActivity];
    if (expected && !expected.includes(loaded.status.activity)) return null;

    const next = mergeRuntimeStatus(loaded.status, {
      ...updates,
      instanceId: nextInstanceId,
    });
    atomicWriteJsonSync(p, next);
    return next;
  });
}

/**
 * Publish an agent lifecycle transition. Re-publishing the current activity
 * preserves activityChangedAt so heartbeat-style updates do not make an old
 * queued/starting state look fresh.
 */
export async function setRuntimeActivity(
  teamName: string,
  agentName: string,
  activity: AgentActivity,
  updates: Partial<AgentRuntimeStatus> = {}
): Promise<AgentRuntimeStatus> {
  return writeRuntimeStatus(teamName, agentName, {
    ...updates,
    activity,
  });
}

export function getProcessStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fieldsFromState = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fieldsFromState[19]; // /proc/<pid>/stat field 22: process start time
  } catch {
    return undefined;
  }
}

/**
 * Identity check for destructive signals. Unlike {@link isRuntimeProcessAlive},
 * an unreadable start token does not count as a match: skip the signal instead
 * of killing whatever now owns that PID.
 */
export function hasConfirmedProcessIdentity(status: Pick<AgentRuntimeStatus, "pid" | "processStartToken">): boolean {
  if (status.pid === undefined || !status.processStartToken) return false;
  if (!isProcessAlive(status.pid)) return false;
  const currentToken = getProcessStartToken(status.pid);
  return currentToken !== undefined && currentToken === status.processStartToken;
}

export function isRuntimeProcessAlive(status: Pick<AgentRuntimeStatus, "pid" | "processStartToken">): boolean {
  if (status.pid === undefined || !isProcessAlive(status.pid)) return false;
  if (!status.processStartToken) return true;
  const currentToken = getProcessStartToken(status.pid);
  return currentToken === undefined || currentToken === status.processStartToken;
}

/**
 * Atomically transition an idle recipient to queued after inbox delivery.
 * Returns false when the runtime is missing or the agent became active first.
 */
export async function markRuntimeQueuedIfIdle(
  teamName: string,
  agentName: string
): Promise<boolean> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return false;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return false;
    const loaded = readRuntimeFile(p, teamName, agentName);
    if (!loaded) return false;

    // Only an idle recipient becomes queued. Interrupted, running, waiting,
    // stopped, and starting sessions keep their activity so ordinary mail
    // cannot auto-resume a user-aborted run.
    if (loaded.status.activity !== "idle") {
      if (loaded.changed) {
        atomicWriteJsonSync(p, loaded.status);
      }
      return false;
    }

    const next: AgentRuntimeStatus = {
      ...loaded.status,
      activity: "queued",
      activityChangedAt: Date.now(),
    };
    atomicWriteJsonSync(p, next);
    return true;
  });
}

/**
 * Read runtime status for an agent. Returns null if not found.
 */
export async function readRuntimeStatus(
  teamName: string,
  agentName: string
): Promise<AgentRuntimeStatus | null> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return null;
    const loaded = readRuntimeFile(p, teamName, agentName);
    if (!loaded) return null;
    if (loaded.changed) {
      atomicWriteJsonSync(p, loaded.status);
    }
    return loaded.status;
  });
}

/**
 * Delete runtime status for an agent. Called during shutdown.
 */
export async function deleteRuntimeStatus(
  teamName: string,
  agentName: string
): Promise<boolean> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return false;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return false;
    try {
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Clean up stale runtime files for a team.
 * Removes files older than RUNTIME_STALE_MS that have no recent heartbeat.
 * Returns the number of files cleaned up.
 */
export async function cleanupStaleRuntimeFiles(
  teamName: string,
  now: number = Date.now()
): Promise<number> {
  const runtimeDir = path.join(teamDir(teamName), "runtime");
  if (!fs.existsSync(runtimeDir)) return 0;

  let cleaned = 0;
  const files = fs.readdirSync(runtimeDir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    const p = path.join(runtimeDir, file);
    await withLock(p, async () => {
      if (!fs.existsSync(p)) return;
      try {
        // Re-read under the lock so a heartbeat or lifecycle transition cannot
        // race with cleanup and be deleted after it was refreshed.
        const status = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
        const lastActivity = Math.max(
          status.lastHeartbeatAt ?? 0,
          status.activityChangedAt ?? 0,
          status.startedAt ?? 0
        );
        const processAlive = isRuntimeProcessAlive(status);
        const isStale = !processAlive && (now - lastActivity) > RUNTIME_STALE_MS;

        if (isStale) {
          fs.unlinkSync(p);
          cleaned++;
        }
      } catch {
        // A corrupt status cannot participate in coordination.
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          cleaned++;
        }
      }
    });
  }

  return cleaned;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Create a structured error object from an error.
 */
export function createRuntimeError(error: unknown): RuntimeError {
  return {
    message: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
