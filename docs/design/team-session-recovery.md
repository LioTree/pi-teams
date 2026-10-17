# Persistent team-session recovery

This design describes the recovery implementation, not an independent audit.

## Identity and authority

A roster member stores a `session` binding: the actual Pi session ID, canonical absolute session file, original cwd, agent directory, and project-trust override. A new worker receives its ID, filename and header from `SessionManager.create` in Pi's normal per-project/agent-directory session storage, outside deletable team/task directories. The SDK-generated header is reserved before first launch, without a prompt/model/history entry; Pi's deferred first-message persistence is not mistaken for a missing binding. An explicit session-directory environment override is honored only outside team/task storage. Pi's real `session_start` API confirms the actual ID/file. Restoration requires a confirmed binding and a readable, well-framed original session file; a never-confirmed header-only launch is reported blocked rather than presented as recovered context.

Session identity is not a PID. The runtime record separately holds exclusive instance/PID/process-start-token authority plus the session ID/file. Claims serialize on config then runtime locks. A live attached owner is refused, including a live process that reports stopped but has not detached its old conversation. PID reuse is checked against the actual process-start token. Reloading or switching conversations invalidates the previous closure synchronously before awaiting cleanup; all runtime writes remain instance-fenced.

Each Pi session has a fresh extension closure. Tools and commands forward to the currently attached closure. `/new`, forks, clones, copied custom history, lingering environment variables, the same process, and parent paths do not establish a team identity. A new session cannot inherit the previous session's inbox. The existing explicit `spawn_lead_window` token protocol is an intentional exception: it preallocates the destination session and permits its single matching handoff claimant, not arbitrary live takeover.

No unrelated chat files are searched. Team metadata is enumerated for exact bindings. The header of a known original file identifies it; JSON framing validation rejects corruption, but message contents are not used to infer roles or teams.

## Persistent roster intent

Exiting Pi, Ctrl+D, `/quit`, SIGHUP, or a crash stops a process, not membership. Every member still in the roster remains recovery intent. Only explicit member removal (`process_shutdown_approved`/member removal), or destructive `team_shutdown`, suppresses restoration. Do not infer permanent removal from `stopped` or Pi's `session_shutdown(reason: "quit")`, which also covers terminal loss.

Pi session restoration is not filesystem/process rollback. Background shells, external services, and side effects may survive or have stopped independently. No history is re-executed to reconstruct them.

## Attachment and panes

Resuming the original lead session without team environment hints looks up its exact binding, claims the dead/detached old authority, starts the inbox reader, and performs one bounded roster recovery pass. Live peers are retained even if their pane ID is stale or absent. A pane ID alone is not proof of member liveness.

Missing roster peers with valid confirmed original sessions are opened in new **tmux panes**, anchored to the recovered lead's verified pane. Commands use `--session` with a safely quoted absolute path, the original cwd/agent directory/trust override, and **no spawn-time model or thinking override**. Pi restores actual model/thinking history, including the user's later changes. No assignments, continuation prompts, task transitions, or historical messages are synthesized. Recovery itself never opens a formal work generation.

`delegate_task(reuse: "existing")` on a dead member also preserves its original session rather than silently creating a replacement conversation. That call still creates a new formal assignment/generation; restoration alone does not. `reuse: "replace"` remains an explicit new-conversation operation.

Other adapters can attach the lead/inbox but automatic missing-pane restoration is reported unsupported. Recovery does not globally select a tmux window. If the lead anchor is unavailable, launch fails rather than splitting an unrelated window. Per-pane nonces reconcile partial launches; they are not evidence that Pi finished loading context or work.

## Reservations and failures

Both initial formal worker launches and pane recovery reserve a nonce in member metadata before launch, under the config lock. Recovery checks the leader runtime authority again under its runtime lock before launching; initial launches similarly fence the calling owner's lease. Config-to-runtime is the lock order; there is no runtime-to-config wait.

A successful terminal launch records its actual pane ID; the child confirms the binding at Pi startup. A real post-launch config-write failure, or unknown launch result, retains the reservation, identity, task, and mailbox. Reconciliation finds only the matching tmux nonce and never blindly launches another process. Stale child nonces cannot attach over a newer reservation. A definite adapter pre-launch failure (`spawned: false`) is retryable. An unconfirmed launch without a verifiable pane is reported blocked for human investigation; no infinite restart loop is run.

Missing cwd/session files, corrupt framing, missing legacy mappings, and per-member errors preserve roster/task/mail data and do not prevent a successfully claimed lead from reading its inbox or restoring other valid peers. A post-claim advisory PID-file/UI fault does not abandon the committed owner. Restoration outcomes say whether a pane was launched, is pending registration, was retained alive, or was blocked; they are not task success.

## Pauses, inbox evidence, and inspection watermark

The runtime persists an interruption flag before bootstrap can replace activity. Claiming a paused/stopped member restores `interrupted`; no inbox message or recovery prompt auto-resumes it. A direct user prompt remains the legitimate resume boundary.

Known unknown inbox acceptance is retained across process replacement and recreated as a single-flight pending attempt, not resubmitted or invented as a receipt. Receipt matching and metadata-only ACK policy remain unchanged. If a crash occurred before evidence was persisted, there is no cross-process exactly-once guarantee. Recovery may not claim the provider accepted an old void send. Stored unknown state can require human diagnosis; this feature adds no force-ACK/reset command.

The existing generation/checked watermark and task/message IDs are preserved. Accepted inspection metadata is not invented or acknowledged by bootstrap. Session invalidation is included in inspection receipt/ACK commit guards; a late revoked receipt hands off a matching metadata release duty rather than checking an unrelated run. The prior Q1–Q4 ACK/release semantics remain in force.

## Legacy migration and explicit retry

Existing exact member bindings attach automatically. A live legacy reload may backfill a missing member binding **only when runtime already identifies the exact current Pi ID/file**; PID/environment alone cannot distinguish a reload from `/new` with stale environment. PID-only legacy data therefore fails closed.

`/team-resume <team>` is a narrow explicit lead association/retry command:

- With an existing lead binding, the current Pi ID/file must match; it is not a way to overwrite another conversation.
- If the lead binding is absent, the user explicitly chooses this persisted conversation. Both runtime and advisory old-lead process authority must be gone; no live takeover, session scan, or history inference occurs.
- An already attached lead can request one bounded missing-pane retry for its own team.
- Unmapped legacy teammates remain individually blocked. No recent-file guessing, fresh chat masquerading as recovery, or deletion occurs.

## Operational limits

- Recovery is on startup/reload or explicit bounded retry, not an LLM/polling restart monitor.
- An unknown launch with no verifiable nonce is intentionally blocked, not retried automatically.
- Paths are absolute and local; moving/deleting the original file, cwd, agent directory, or changing machines can require manual repair.
- Multi-file commits are not a distributed transaction. Config binding precedes runtime admission; partial errors are visible and retry the same identity. The advisory lead PID record is not exclusive authority.
- `team_shutdown` remains destructive to roster/task/mail metadata, not Pi conversation history. Fresh worker chats live in normal persistent Pi session storage, survive dissolution unchanged, and remain discoverable for manual `/resume`; deleted membership is not automatically reconstructed. Explicit member removal likewise leaves chat files intact. Known saved paths are honored, not retargeted or batch-migrated; the unreleased author's former team-local temporary fixtures are historical evidence only. This is not a suspension command.
- Detaching tmux keeps processes alive. Closing a team-exclusive window/session may stop them while leaving roster intent; avoid closing shared project windows. No bulk-close/pause command is added.
- Verification uses isolated files, fake terminal adapters, two narrow subprocess claimants, and the installed Pi SDK with a fake successful stream. It does not invoke real Pi CLI/tmux, providers, or user chat files, and does not certify real TUI/multi-machine behavior.
