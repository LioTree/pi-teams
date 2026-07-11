import type { InboxMessage } from "./models";
import type { AgentActivity } from "./runtime";

export const TEAM_WAIT_POLL_MS = 1000;
export const TEAM_WAIT_INACTIVE_POLLS = 2;

export interface TeamWaitPeer {
  name: string;
  agentType: string;
  alive: boolean;
  activity?: AgentActivity;
  activityChangedAt?: number;
  joinedAt?: number;
  unreadCount: number;
}

export interface TeamWaitMemberSnapshot extends Omit<TeamWaitPeer, "activity"> {
  activity: AgentActivity | "unknown";
  progressCapable: boolean;
  stalled: boolean;
  reason: "dead" | "unread_message" | "active" | "waiting" | "idle" | "stopped" | "startup_stalled";
}

export type TeamWaitOutcome = "message" | "no_active_agents" | "timeout";

export interface TeamWaitResult {
  outcome: TeamWaitOutcome;
  messages: InboxMessage[];
  waitedMs: number;
  timedOut: boolean;
  members: TeamWaitMemberSnapshot[];
}

export interface WaitForTeamOptions {
  consumeMessages: () => Promise<InboxMessage[]>;
  getPeers: () => Promise<TeamWaitPeer[]>;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  inactivePolls?: number;
  startupGraceMs?: number;
  now?: () => number;
  onPoll?: () => void | Promise<void>;
}

export function classifyTeamWaitPeer(
  peer: TeamWaitPeer,
  now = Date.now(),
  startupGraceMs = 60_000,
): TeamWaitMemberSnapshot {
  const activity: AgentActivity | "unknown" = peer.activity ?? "unknown";
  const base = { ...peer, activity };

  if (!peer.alive) {
    return { ...base, progressCapable: false, stalled: false, reason: "dead" };
  }

  if (activity === "stopped") {
    return { ...base, progressCapable: false, stalled: false, reason: "stopped" };
  }

  if (activity === "starting" || activity === "queued" || activity === "unknown") {
    const changedAt = peer.activityChangedAt ?? peer.joinedAt ?? now;
    if (now - changedAt > startupGraceMs) {
      return { ...base, progressCapable: false, stalled: true, reason: "startup_stalled" };
    }
  }

  // A live waiter with unread mail can consume it and resume, regardless of
  // whether its last recorded state was waiting or idle. A startup/queue that
  // has already stalled is handled above so a permanently undeliverable
  // message cannot keep every other waiter blocked forever.
  if (peer.unreadCount > 0) {
    return { ...base, progressCapable: true, stalled: false, reason: "unread_message" };
  }

  if (activity === "running") {
    return { ...base, progressCapable: true, stalled: false, reason: "active" };
  }

  if (activity === "starting" || activity === "queued" || activity === "unknown") {
    return { ...base, progressCapable: true, stalled: false, reason: "active" };
  }

  if (activity === "waiting") {
    return { ...base, progressCapable: false, stalled: false, reason: "waiting" };
  }

  if (activity === "idle") {
    return { ...base, progressCapable: false, stalled: false, reason: "idle" };
  }

  return { ...base, progressCapable: false, stalled: false, reason: "stopped" };
}

function abortError(): Error {
  const error = new Error("team_wait aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForTeam(options: WaitForTeamOptions): Promise<TeamWaitResult> {
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? TEAM_WAIT_POLL_MS);
  const requiredInactivePolls = Math.max(1, options.inactivePolls ?? TEAM_WAIT_INACTIVE_POLLS);
  const startupGraceMs = options.startupGraceMs ?? 60_000;
  const timeoutMs = options.timeoutSeconds === undefined
    ? undefined
    : options.timeoutSeconds * 1000;
  const startedAt = now();
  let consecutiveInactivePolls = 0;
  let lastMembers: TeamWaitMemberSnapshot[] = [];

  const finish = async (outcome: Exclude<TeamWaitOutcome, "message">): Promise<TeamWaitResult> => {
    // Close the common race where a message arrives after the poll's first
    // inbox read but before an inactivity/timeout decision is returned.
    const messages = await options.consumeMessages();
    const waitedMs = now() - startedAt;
    if (messages.length > 0) {
      return { outcome: "message", messages, waitedMs, timedOut: false, members: lastMembers };
    }
    return {
      outcome,
      messages: [],
      waitedMs,
      timedOut: outcome === "timeout",
      members: lastMembers,
    };
  };

  while (true) {
    if (options.signal?.aborted) throw abortError();

    // Messages always win over inactivity and timeout checks.
    const messages = await options.consumeMessages();
    if (messages.length > 0) {
      // Never perform another fallible filesystem operation after consuming
      // messages: the inbox read has already acknowledged them.
      return {
        outcome: "message",
        messages,
        waitedMs: now() - startedAt,
        timedOut: false,
        members: lastMembers,
      };
    }

    const peers = await options.getPeers();
    const currentTime = now();
    const members = peers.map(peer => classifyTeamWaitPeer(peer, currentTime, startupGraceMs));
    lastMembers = members;
    const waitedMs = currentTime - startedAt;

    if (members.some(member => member.progressCapable)) {
      consecutiveInactivePolls = 0;
    } else {
      consecutiveInactivePolls += 1;
      if (consecutiveInactivePolls >= requiredInactivePolls) {
        return finish("no_active_agents");
      }
    }

    if (timeoutMs !== undefined && waitedMs >= timeoutMs) {
      return finish("timeout");
    }

    await options.onPoll?.();
    const remainingMs = timeoutMs === undefined ? pollIntervalMs : timeoutMs - waitedMs;
    await delay(Math.min(pollIntervalMs, Math.max(1, remainingMs)), options.signal);
  }
}
