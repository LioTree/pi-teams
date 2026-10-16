import type { InboxMessage } from "./models";
import type { AgentActivity } from "./runtime";
import type { ControlMode } from "./control-state";

export const TEAM_WAIT_POLL_MS = 1000;
export const TEAM_WAIT_INACTIVE_POLLS = 2;

export interface TeamWaitPeer {
  name: string;
  agentType: string;
  alive: boolean;
  activity?: AgentActivity;
  controlMode?: ControlMode;
  activityChangedAt?: number;
  joinedAt?: number;
  unreadCount: number;
}

export interface TeamWaitMemberSnapshot extends Omit<TeamWaitPeer, "activity"> {
  activity: AgentActivity | "unknown";
  progressCapable: boolean;
  stalled: boolean;
  reason: "dead" | "unread_message" | "active" | "waiting" | "idle" | "interrupted" | "user_controlled" | "stopped" | "startup_stalled";
}

/** A live interrupted peer is not progress-capable, but it keeps an indefinite wait open. */
export function interruptedPeerHoldsWait(
  member: Pick<TeamWaitMemberSnapshot, "alive" | "activity">,
): boolean {
  return member.alive && member.activity === "interrupted";
}

/** Ownership is not activity: a live human-owned peer suspends inactivity only. */
export function userControlledPeerHoldsWait(
  member: Pick<TeamWaitMemberSnapshot, "alive" | "activity" | "controlMode">,
): boolean {
  return member.alive && member.activity !== "stopped" && member.controlMode === "user";
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

  // Unread mail must not make a paused session progress-capable, and startup
  // grace / staleness deadlines do not apply while it remains alive.
  if (activity === "interrupted") {
    return { ...base, progressCapable: false, stalled: false, reason: "interrupted" };
  }

  if (peer.controlMode === "user") {
    // Only actual running work, or the already-active dependency wait's mail,
    // can progress. Pending idle mail must not invent progress or start a turn.
    if (activity === "running") return { ...base, progressCapable: true, stalled: false, reason: "active" };
    if (activity === "waiting" && peer.unreadCount > 0) return { ...base, progressCapable: true, stalled: false, reason: "unread_message" };
    return { ...base, progressCapable: false, stalled: false, reason: "user_controlled" };
  }

  if (activity === "starting" || activity === "queued" || activity === "unknown") {
    const changedAt = peer.activityChangedAt ?? peer.joinedAt ?? now;
    if (now - changedAt > startupGraceMs) {
      return { ...base, progressCapable: false, stalled: true, reason: "startup_stalled" };
    }
  }

  // A live waiting or idle peer with unread mail can consume it and resume.
  // Interrupted peers are excluded above. A startup/queue that has already
  // stalled is handled above so a permanently undeliverable message cannot
  // keep every other waiter blocked forever.
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
    // The final recheck is still a consumption attempt. Cancellation that
    // wins before its acknowledgement commit must reject from consumeMessages.
    if (options.signal?.aborted) throw abortError();
    const messages = await options.consumeMessages();
    const waitedMs = now() - startedAt;
    if (messages.length > 0) {
      return { outcome: "message", messages, waitedMs, timedOut: false, members: lastMembers };
    }
    if (options.signal?.aborted) throw abortError();
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

    // Messages always win over inactivity and timeout checks. Returning
    // messages means consumeMessages already committed acknowledgement;
    // do not throw afterwards and hide that mail.
    const messages = await options.consumeMessages();
    if (messages.length > 0) {
      return {
        outcome: "message",
        messages,
        waitedMs: now() - startedAt,
        timedOut: false,
        members: lastMembers,
      };
    }
    if (options.signal?.aborted) throw abortError();

    const peers = await options.getPeers();
    const currentTime = now();
    const members = peers.map(peer => classifyTeamWaitPeer(peer, currentTime, startupGraceMs));
    lastMembers = members;
    const waitedMs = currentTime - startedAt;

    // Interrupted peers are not progress-capable, but they are not inactive
    // either. Reset the streak so a later idle poll cannot combine with a
    // pre-interruption poll and return no_active_agents while the pause holds.
    if (members.some(member => member.progressCapable) || members.some(interruptedPeerHoldsWait) || members.some(userControlledPeerHoldsWait)) {
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
