# Team session recovery — independent scoped review

Date: 2026-10-17. Reviewer: astra-design-review (not the feature author).

## Corrected verdict

The previously reported high finding is **withdrawn in its stated form**. The current helper is `src/utils/team-session.ts` SHA-256 `e73c486f8566899c087d0a9b5ea69940b64c0dfb0f99a9b3065041035f65a00a`; it already re-reads roster membership and runtime authority inside the team configuration lock before creating a recovery reservation. The earlier report incorrectly described a snapshot-only restoration loop and carried over stale quiescence test counts.

Within the narrow evidence actually collected, there is **no certified duplicate-resume or member-resurrection defect**. Both reviewer timing assertions relied on an expected `blocked` outcome without a deterministic interposition point; current source and lock inspection do not support either claimed race. No broader fault hunting was performed during this correction pass, so this is not a global approval.

The feature remains unapproved only because independent review does not itself merge or grant product approval; the reviewed recovery/history mechanism has no actionable finding from this corrected pass.

## Correction of the two reviewer schedules

Evidence fixture: `/tmp/pi-teams-session-recovery-review/history/race.test.ts`; raw log: `/tmp/pi-teams-session-recovery-review/history/logs/race.log`.

### R1 — duplicate resume after concurrent `claimSession`: withdrawn

The fixture starts restoration, waits 10 ms, then calls `claimSession` for the same identity. It observed `status === "restored"` and one terminal `spawn` call, then asserted that this was a duplicate resume.

That inference is not supported:

- `restoreTeamPanes` performs its roster/authority recheck inside `withLock(configFile, …)` before it reserves recovery.
- The fake terminal records exactly one restoration spawn. The reviewer fixture does not launch a second process.
- A later exact-session attach can reconcile with the recovery pane through `findRecoveryPane(recoveryToken)`; that is not evidence of two live resume writers.
- The test has no ordering trace proving that `claimSession` committed before restoration's terminal spawn rather than attaching/reconciling after it.

Accordingly, the claim “two resume processes can target one JSONL concurrently” is **unproven and withdrawn**. The raw failed assertion remains on disk as historical reviewer evidence; it must not be cited as a certified defect.

### R2 — explicit removal during restoration: withdrawn

The fixture starts restoration, waits 10 ms, calls `removeMember`, and first asserts that the outcome must be `blocked`. The raw log shows `restored`; execution stopped at that first assertion and therefore never proved that the member remained in the roster.

Current source inspection further invalidates the claimed resurrection mechanism:

- restoration's entire decision, reservation, leader-runtime lock, synchronous terminal spawn, and final config write occur inside one `withLock(configFile, …)` callback;
- `withLock` releases the config lock only after that callback settles;
- `removeMember` must acquire the same config lock, so a concurrent removal either completes before restoration's in-lock membership check or waits until restoration has committed and released; it cannot overwrite a removal that committed in the middle, and restoration does not use a stale post-lock `updateRoster` call;
- an already-removed member is handled by the in-lock check `if (!member) return { status: "blocked", note: "member removed" }`.

The observed `restored` value therefore indicates that the unmeasured 10 ms injection did not establish the asserted ordering. It is not evidence that a removed member was resurrected. The old R2 finding is withdrawn.

## Verified current source facts

These statements were checked against the current code and installed Pi SDK 1.1.0:

- Session allocation uses `SessionManager.create(cwd, agentDir)` in `allocateSession`, then `manager.getSessionFile()`. It does **not** use a `SessionManager.allocate()` API.
- The stored identity is `{ file, id, agentDir }`; `file` is passed through `canonicalSessionFile(...)`. The code explicitly rejects a file/directory that overlaps deletable team or task metadata.
- With normal Pi storage, sessions remain in Pi's per-project session tree under the effective agent directory (`projects/.../*.jsonl` in the installed SDK implementation). The feature does not place transcript JSONL in the deletable team directory.
- Resume commands are built by `buildResumeCommand` as:
  - `pi --session "<absolute canonical session file>"` for normal resume;
  - the exact absolute file is also used for lead handoff, with the one-time `PI_TEAM_HANDOFF_TOKEN` environment variable.
- The current code does **not** pass `--session-dir <dir> --session <id>`. It passes the canonical absolute session file.
- Initial/delegate launch paths omit `--model` and `--thinking`; they rely on the resumed Pi conversation's saved model/thinking context rather than reapplying defaults.
- `claimSession` validates the exact canonical file and session ID through `SessionManager.open(file)`, rejects copied/non-canonical identities, and uses a recovery nonce for bounded pane recovery.
- Team dissolution/deletion removes team metadata, task metadata, inboxes, runtime state, and advisory PIDs, but does not delete the referenced Pi session JSONL. Existing extension tests reopen the preserved session through `SessionManager.open(...)` and verify model/thinking/message retention.
- Manual quit/SIGHUP-represented-as-`session_shutdown(reason="quit")` does not remove roster membership; explicit member removal or team dissolution remains the recovery boundary.
- Explicit process approval remains separate from metadata removal while a member process is live.

The old report's statements naming `SessionManager.allocate()`, `--session-dir <dir> --session <id>`, and a claimed implementation that stored sessions by a different allocation call were not true for this Task27 source and have been removed.

## Commands and counts

Working directory: `/home/liontree/pi-teams`. HEAD: `55bfb34d7ce5bbcc28a9be614fbc8bec6bb97346`; Task27 files were uncommitted working-tree changes. Installed Pi SDK/package version: **1.1.0**.

The full command used the repository default Vitest configuration, with no `--config`:

| Actual argv | Exit | Raw result |
| --- | ---: | --- |
| `node node_modules/vitest/vitest.mjs run` | 0 | 28 test files / 364 tests passed |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | no output/error |
| `git diff --check` | 0 | no output/error |
| `node node_modules/vitest/vitest.mjs run --config /tmp/pi-teams-session-recovery-review/history/race-vitest.config.mjs` | 1 | reviewer fixture: 2 assertions failed; both are now reassessed above |

The earlier `26 files / 325 tests` wording was a transcription error carried forward from the prior quiescence review. The original full log was not replaced or rerun for the correction; it already reported 28/364, including 18 `team-session` tests. Reconciliation evidence: `/tmp/pi-teams-session-recovery-review/history/count-reconciliation.json`.

Commands used isolated `HOME=/tmp/pi-teams-session-recovery-review/history/home` and `PI_AGENT_DIR=.../agent`, with the reviewer guard in `NODE_OPTIONS`. Guard delta: **0 bytes**. The guard is application-level isolation, not an OS sandbox.

## Fingerprints/provenance

The Task27 manifest is `/tmp/pi-teams-session-recovery-author/history-preservation/source.sha256.json`; it contains **27 entries** (20 TypeScript files and 7 Markdown files). All 27 current hashes matched after review. Key current hashes:

- `extensions/index.ts` — `868eb49fd352bdc904ab38f5cbd74bc9b644867d3a977ed82de588e9324b3643`
- `src/utils/team-session.ts` — `e73c486f8566899c087d0a9b5ea69940b64c0dfb0f99a9b3065041035f65a00a`
- `src/utils/member-launch.ts` — `5a3c793f9f335bb8d9ddb5e28bc6f433b4d9cdadb197c3f604ef5dd6fa4cc8a0`

Evidence:

- corrected report: `docs/audits/team-session-recovery.md`
- misnamed superseded draft preserved verbatim: `/tmp/pi-teams-session-recovery-review/history/superseded/session-recovery-history.superseded-draft.md`
- withdrawn reviewer fixture and raw log (historical evidence only): `/tmp/pi-teams-session-recovery-review/history/race.test.ts`, `logs/race.log`
- full/typecheck/diffcheck logs and argv: `/tmp/pi-teams-session-recovery-review/history/logs/`
- hash/count proof: `source-before.json`, `proof-after.json`, `count-reconciliation.json`

## Preselected risk coverage (no additional fault hunting)

The original review's selected risk areas were reconciled against current source and the repository tests that ran in the 364-test full suite. This is a coverage review, not a claim that the author tests substitute for real tmux/TUI operation:

1. **Original lead mail restoration and missing peer panes** — `extensions/session-recovery.test.ts:106` resumes the dead original lead, reads explicit mail, and restores the peer's exact session; source startup restores panes after lead claim without task replay.
2. **Exclusive owner claims / stale shutdown** — `src/utils/team-session.test.ts:84` and `:93` cover in-process contention and two real Node subprocesses; `extensions/session-recovery.test.ts:299` covers delayed shutdown against a replacement owner.
3. **new/fork/clone/copied identity isolation** — `extensions/session-recovery.test.ts:135` and `:362` verify those reasons do not inherit team ownership; `team-session.test.ts:125` rejects a copied canonical transcript.
4. **Partial spawn / reservation and nonce reconciliation** — `team-session.test.ts:208`, `:225`, and extension test `:225` cover post-spawn config failure, unknown launch outcome, definite no-spawn failure, retained task/mail/session state, and refusal to blind-duplicate.
5. **Explicit removal / live peer / stale launch** — `team-session.test.ts:165`, `:173`, `:189`, and `:236` cover a stale nonce, a live peer with a missing/recycled pane, roster removal before restoration, and detach/replacement after a real config-lock wait. The latter existing deterministic lock-wait test is valid; the reviewer's untimed 10 ms R1/R2 fixture is not.
6. **Paused state and unknown inbox acceptance across replacement** — `team-session.test.ts:181` and extension test `:186` preserve interruption pause and unknown single-flight metadata without injecting a duplicate message.
7. **History/model preservation after shutdown** — extension tests `:311` and `:331` use a successful fake-provider SDK lifecycle and verify exact-session reload, model/thinking retention, and history survival after registered team dissolution.
8. **Honest blocking for missing/corrupt/legacy mappings; tmux-only restore** — `team-session.test.ts:196`, `:246`, `:256`, plus extension tests `:172` and `:197`, cover missing/corrupt mappings, orphan live PID evidence, non-tmux restoration limits, and bounded dead-lead-only legacy association.

No actionable issue remains in this reviewed scope. Config-lock serialization protects the specific R1/R2 schedules the reviewer actually proposed. This statement does not certify untested real terminal races, future Pi 2.x session-format changes, or the broader harness outside session recovery.

## Limits

No real Pi CLI, provider call, network access, live `~/.pi` data, real tmux pane, terminal SIGHUP, or multi-process TUI session was launched by the reviewer. Terminal behavior in the focused fixture is fake/synchronous while filesystem locks and roster/runtime modules are real. Existing extension tests include a successful fake-provider SDK lifecycle, but that is not a real provider or interactive TUI certification.

This correction did not rerun the full suite; it reconciled the already-existing raw 28/364 log. No new fault injection was added after the lead's correction request.
