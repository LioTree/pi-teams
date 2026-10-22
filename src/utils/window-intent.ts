import type {
  Member,
  MemberWindowIntent,
  WindowIntentReason,
  WindowIntentState,
} from "./models";

/** Missing metadata is a legacy roster member: it was intended to be visible. */
export function windowIntentState(
  member: Pick<Member, "windowIntent"> | undefined,
): WindowIntentState {
  return member?.windowIntent?.state ?? "open";
}

export function windowIntentEpoch(
  member: Pick<Member, "windowIntent"> | undefined,
): number {
  return member?.windowIntent?.epoch ?? 0;
}

/**
 * Build the next durable intent. The epoch is monotonic per member so a late
 * rollback cannot erase a newer explicit resume or another close.
 */
export function nextWindowIntent(
  current: MemberWindowIntent | undefined,
  state: WindowIntentState,
  reason: WindowIntentReason,
  now: number = Date.now(),
): MemberWindowIntent {
  return {
    state,
    epoch: (current?.epoch ?? 0) + 1,
    changedAt: now,
    reason,
  };
}

export function sameWindowIntent(
  left: MemberWindowIntent | undefined,
  right: MemberWindowIntent | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.state === right.state
    && left.epoch === right.epoch
    && left.changedAt === right.changedAt
    && left.reason === right.reason;
}

/** Automatic recovery only opens members whose last explicit intent is open. */
export function recoveryModeFor(
  member: Pick<Member, "windowIntent"> | undefined,
): "auto" | "manual" {
  return windowIntentState(member) === "open" ? "auto" : "manual";
}
