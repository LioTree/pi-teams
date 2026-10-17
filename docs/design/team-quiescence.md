# Team Quiescence Fallback

Status: implemented on `feat/team-quiescence-check` (uncommitted at time of writing), pending independent review.
Scope: replace routine per-teammate idle notifications with one team-wide fallback inspection per formal dispatch generation.

## Problem

Every teammate settlement to `idle` used to send the lead a notice. In a team that finishes its work and then has normal human-to-teammate conversations, each teammate turn produced another notice and woke the lead again. The notice was also easy to mistake for a completion report.

## Model

- **Formal dispatch opens a generation.** `delegate_task` (new work, follow-up, or re-dispatch of a live teammate) and a successful `create_predefined_team` worker launch call `openFormalGeneration`. Team creation alone, draft task creation, direct user prompts, model changes, status polling, ordinary `team_message`, progress updates, task claims, and acknowledgements do not.
- **Quiescence is checked against the live snapshot.** Every member must be alive and `idle`, with no queued/starting/running/waiting/interrupted activity, no unread mail, and no unknown inbox acceptance. This includes the lead. `stopped` and dead members do not block the check; they are reported as faults and never treated as success. An `interrupted` member blocks it and is never resumed by this mechanism.
- **At most one inspection per admission.** `admitQuiescenceInspection` stores a reserved message ID before appending, so a retry after a storage failure cannot create a duplicate. While an inspection is pending or accepted, later admissions are single-flight. If a newer generation is opened while an unread inspection is still pending and the lead is idle with no other mail, the pending message is retagged to the latest generation instead of appending a second one.
- **Acceptance is a real host boundary.** The generation is tagged in the inspection text. The lead's `message_end` for the actual delivered user message records `accepted` with the lead instance and run generation. A void `sendUserMessage`, a timer, an assistant `message_end`, or a plain report cannot record acceptance.
- **Only a normal accepted settlement checks.** `agent_settled(aborted: false)` after an accepted inspection calls `acknowledgeAcceptedInspection`, which checks the tagged generation. The coordinator revalidates the current leader lease and the still-authorized acknowledgement obligation at the commit boundary, inside the coordinator lock: a replacement lease or an acknowledgement revoked by a later abort (or stop/shutdown) cannot commit the check. A rejection because the obligation was revoked does not discard the durable record with it: the inspection is handed to the same retryable release duty described below, so the aborted inspection is never acknowledged and the durable `accepted` record cannot be stranded. A rejection because the record is no longer ours is conclusive ownership loss. An abort (or local interruption) releases the acceptance without checking it. Release is a separate, retryable metadata duty: a transient write failure keeps it with capped backoff until the durable record is released or conclusively no longer ours, and the retry never starts a model or admits an inspection while the session is paused. A successful release still requires a fresh inspection on a later run; an unrelated normal settlement never checks it. A settlement that never accepted an inspection checks nothing. A checked generation stays checked across later human turns and unrelated settlements.
- **Delivery is a `user` run.** The inspection uses the same inbox-delivery path as other mail: queued for the lead, delivered only when the lead is idle, delivered as a user message, acknowledged on the host `message_end`. Inspection delivery must not re-enter an `agent_settled` that is still finishing, so an in-process `settlementActive` guard blocks re-entrant injection and the settlement itself admits the next inspection.
- **Explicit reports are untouched.** `team_message`, assignment notifications, and `task_complete` notifications are appended immediately and are not held, muted, or routed through the watermark.

## Non-goals

- No semantic or LLM classification of messages, no `team-mode` ownership, no held reports, no manual close/reset tool, and no ordering by wall-clock idle timestamps.
- An inspection is not task completion. It never changes a task, never claims the work is done, and the lead must inspect artifacts and either finish the work or formally dispatch more (`delegate_task`).
- An ordinary `team_message` that says "continue" does not re-arm the fallback. This is a documented work-boundary limitation, not content guessing.

## Failure and restart limits

- The watermark lives in the team directory as `quiescence.json`. It is local coordination state, not a distributed exactly-once protocol.
- Corrupt or unreadable state fails loudly (no silent reset); a failed append keeps the reserved ID for retry.
- A concurrent append failure may leave a reserved inspection with no message; the next admission reuses the reserved ID.
- A process restart loses in-memory acceptance and any pending release duty; the next admission sees a different lead instance and drops the stale accepted record. A later normal run can still accept a fresh inspection for an unchecked generation.
- A failed release keeps its in-memory duty with capped backoff (a bounded interval, not a bounded lifetime). It does not drop after a finite number of attempts; only a durable success, a `false` return proving the record is no longer ours, process end, or team deletion ends it.
- An inspection delivered but not accepted (unknown host acceptance) stays unread and single-flight through the existing inbox policy; this change does not resend it.
- Retagging requires the lead to be idle with the pending message unread. When the message was already delivered or accepted, a newer generation produces one additional bounded inspection instead of coalescing.
- Multiple workers settling concurrently serialize on the coordinator lock, so only one inspection is appended.

## Verification

`src/utils/quiescence.test.ts` covers the watermark, tagging, coalescing, acceptance/release, corrupt state, and retry idempotency. `extensions/quiescence.test.ts` covers the registered tool/lifecycle behavior, including dispatch via `delegate_task` and a predefined-template launch, the real host `message_end` acceptance path with a fake provider, abort/no-resume, human multi-turn non-rearming, explicit reports, and the absence of control-mode API. See the task handoff in `/tmp/pi-teams-quiescence-author/handoff.md` for exact commands and counts.
