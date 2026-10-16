# Independent audit: teammate control mode

## Current verdict — 2026-10-16

**TC1 is resolved on the reviewed frozen source. No actionable findings remain within the bounded scope reviewed.** This is not a global safety claim or exhaustive interleaving proof. The original findings round stopped at TC1; the follow-up independently verified its repair and completed the selected remaining control-mode schedules below. No implementation, repository test, or prior audit was edited by this reviewer.

Actual reviewer: **openai-codex/gpt-6-astra** (user-selected authentication route). Source review and test execution ran at **high**; after the user changed thinking to **medium** at `2026-10-16T12:33:26.988Z`, work paused, then the user explicitly authorized medium for finishing this review. Report/evidence finalization ran at **medium**. No reviewer-initiated model/thinking switch occurred. Evidence: `current-model-provenance.json`, `followup/model-provenance.json`, `followup/resume-proof.json`, and `followup/final-model-provenance.json` under the artifact root below. Earlier Sol/xhigh responses were startup checks, not this review.

Source: branch `fix/interrupted-team-wait`, HEAD `fbb5001b6926db28126419b306a6d42df4acc862`. Follow-up input matched **all 82 files** in `/tmp/pi-teams-control-mode-tc1-fix/source-manifest.json`, including this report's previous version. All 82 remained unchanged through tests and the later resume check. Final comparison permits **only this report** to change. Installed `pi-coding-agent`, `pi-agent-core`, and `pi-ai`: **1.1.0**.

## TC1 — P3, resolved: consumed release receipt falsely queued the leader

The original `src/utils/control.ts` incremented `batches` for successful cleanup of an already-read receipt, then unconditionally called `markRuntimeQueuedIfIdle`. Independent reproduction injected one outbox-cleanup write failure after actual mailbox append, consumed that batch through the real inbox API, restored leader idle, then retried handback. Result: **one read history record, zero unread, leader queued**. Original independent result was **2 passing controls / 1 failing regression**. The normal empty-inbox poll could correct the metadata, so severity was P3; no duplicated report, lost content, or extra model call was established.

The repair retains the cleanup-count meaning of `batches`, separately records batch IDs, and uses `markUnreadMessagesQueuedIfIdle` (`src/utils/messaging.ts:104–123`, called from `src/utils/control.ts:198`). That helper holds the recipient inbox lock while checking those IDs and awaiting the idle-only runtime commit. Consumption cannot interleave between the unread check and commit. Runtime mode/activity checks still preserve user ownership, interruption and stop. The control lock is released before queue signalling. Inspection found no new runtime-to-control await cycle: admission releases runtime before waiting on control; inbox consumption and signalling use inbox-to-runtime ordering. Signal failures remain best-effort metadata, not failed durable delivery.

The **unchanged original three-case fixture now passes 3/3**. Current observation is one read record, zero unread, **leader idle**. Fixture SHA256: `a7cc5da894470914afbe680c2975f017608c14a3652651976c7f163f119306de`. Original failing observation/log were preserved, not overwritten or relabeled. New observation: `followup/tc1-current-observation.json`; preservation proof: `followup/original3-verification.json`.

## Independent coverage

Scoped source pass covered control ownership/nonce locking, report holding and release, completion intent and late original sends, local command/idle-poll/settlement/resume integration, delegation and intentional removal, runtime queue signalling, and wait classification. Reviewed the baseline-relative feature diff and three-file TC1 repair diff rather than treating the earlier interrupted-wait patch as new work. Installed command dispatch was checked against `AgentSession.prompt` and `_tryExecuteExtensionCommand`: extension commands dispatch before streaming prompt handling. Existing installed Pi command/extension/UI documentation was reused, not broadly researched again.

`followup/focused.test.ts` contains **nine newly authored schedules**. Setup/host scaffolding was adapted from the repository's control-mode fixture; this is disclosed reuse, not nine wholly independent harnesses. The schedules use actual control/inbox/runtime file operations and locks with isolated paths, fake timers, and explicit gates:

1. Actual installed `AgentSession.prompt`/`ExtensionRunner`/core loop: busy `/team-mode user`, two direct human turns in the same host, held leader report, explicit dependency wait consumption, and flush remaining user-controlled. Commands add no fake-provider calls; runner errors are asserted absent.
2. Outbound append blocked on the real leader inbox lock must finish before takeover commits; subsequent reports stay held.
3. Delegation holds control through actual task/mail commits while takeover waits; a later replacement request rejects without task/config/model side effects.
4. A live control owner survives simulated >30-second elapsed time; a stale reused-PID/wrong-start-token lock is reclaimed; forced nonce replacement fences an old callback and preserves the newer lock.
5. Completion commits behind a release snapshot gate, is reassigned, then recovered; reading the batch before the original send resumes causes neither duplicate hold/delivery nor phantom queue.
6. An unknown handed-off request survives an unrelated actual direct human turn in user mode; only matching actual acceptance acknowledges it, with no idle reinjection.
7. TC1 queue signalling retains the real inbox lock while waiting for runtime; simulated competing committed stopped/interrupted/user state wins at the runtime commit.
8. Handback delayed at the real inbox lock suppresses already-covered settled generations, but permits a genuinely later team run's idle report.
9. Source runtime replacement wins while release waits on the inbox; successor explicitly recovers immutable old and new reports as separate batches.

The **340 repository-authored tests were also rerun independently**, including prior C1–C4/interruption/unknown-single-flight/accepted-metadata-ACK regressions and the control-mode cases. These cover additional stale-poll admission, accepted ACK storage failures, partial cleanup with new reports and read/unread receipts, hooks, broadcast recipients, user-owned waits, and restart/retirement behavior. Those are repository tests, not additional newly authored schedules. Combined source review and selected new schedules complete this bounded follow-up; no claim is made that every failure schedule was independently reimplemented.

## Verification and artifacts

Root: `/tmp/pi-teams-control-mode-audit/`. Exact wrapper source is retained as `run-check.sh`; it invokes local Node/Vitest/TypeScript entry points, not package installation or provider tests.

| Final invocation (wrapper path relative to root) | Result | Log/result stem under `logs/` |
| --- | --- | --- |
| `bash run-check.sh followup-full-final` | **26 files / 340 passed**, exit 0 | `followup-full-final` |
| `bash run-check.sh followup-original3 --root /tmp/pi-teams-control-mode-audit release-receipt.test.ts` | **1 file / 3 passed**, exit 0 | `followup-original3` |
| `bash run-check.sh followup-focused-final --root /tmp/pi-teams-control-mode-audit/followup focused.test.ts` | **1 file / 9 passed**, exit 0 | `followup-focused-final` |
| `bash run-check.sh typecheck-followup-final` | `tsc --noEmit`, exit 0 | `typecheck-followup-final` |
| `git diff --check` | exit 0 | `diffcheck-followup-final` |

Each of the four final guarded calls recorded **0→0 guard bytes, delta 0**. The original fixture's hard-coded observation output was saved separately and its historical output restored in a `finally` block. Test roots/filters excluded duplicate baseline copies. No unchanged-source rerun was performed after the user resumed this session.

Follow-up execution history is retained: the first focused-fixture invocation failed during Vitest mock-API import resolution (**zero tests executed**, exit 1); changing the fixture import to canonical `vitest` and adding a read-through node_modules symlink fixed that harness issue. The next invocation passed eight schedules; adding the ninth yielded the final 9/9 above. Thus follow-up has six guarded invocations (one harness failure, five successes), all guard delta 0, plus the recorded diff check. Earlier 335-pass findings-round logs and the original failing TC1 repro remain historical evidence, not current failures. The author's separate guard migration denial history is not this reviewer's guard history.

Isolation used the previously reviewed guard, isolated HOME/PI_AGENT_DIR/fixture roots, offline npm settings, and fixed fake-provider streams. The guard is application-level, **not a kernel sandbox**. No real-provider/Pi CLI/network/live-user-state test was run.

Evidence index:
- `followup/checks-verification.json`: actual results, SDK versions and fixture hashes.
- `followup/before-source-manifest.json`, `followup/final-source-manifest.json`: tested input and final source fingerprints.
- `followup/final-verification.json`, `followup/artifact-manifest.json`: final comparison, report hash and artifact inventory.
- `release-receipt.test.ts`, `followup/focused.test.ts`: independently authored assertions; raw logs and observations retained.

Final repair hashes:
- `src/utils/control.ts`: `c8828cc08a097a772ee7abdf4a687b78bcd95bc2c834dd1da3aac2d988f37816`
- `src/utils/messaging.ts`: `c682327b1460fcb60b723b09d00d2a3ecdf65d5f0f66d1043159bfbdb51ca7ec`
- `src/utils/control.test.ts`: `188833c636692f1f24e0c31fac2f4ccb69ae62ee54ff111e62b708ee1cee5486`
- Prior `docs/audits/interrupted-team-wait.md`: `f8a1bb293b5cdf1bed86b8805f2e02de8f4ba5da3f7cd125703df50fd364ad9a` (untouched).

## Limits

No real terminal UI, real provider, Pi CLI, actual multi-process/OS restart, power-loss/fsync guarantee, recovery after manual history deletion, or future Pi 1.x compatibility was tested. Some competing commits and nonce loss are deliberately simulated under actual file-lock gates, not process-crash experiments. Fake timers establish selected ordering/elapsed-time behavior, not scheduler exhaustiveness. Persistent receipt deduplication depends on retained records and is not exactly-once model execution. The old interrupted-wait audit was preserved, not rewritten or globally recertified.
