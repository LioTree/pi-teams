# Team quiescence — independent scoped review

Updated 2026-10-17 UTC. Reviewer: astra-design-review, not feature author. Final verification: Task 23, after Q4 repair.

## Current verdict

**No actionable findings within reviewed scope.** Q1–Q4 are resolved in the independently exercised schedules. This closes this bounded review cycle; it is scoped approval, not a guarantee about all concurrency, restart or host/UI behavior. No implementation changes, commit, push, branch operation or deployment by reviewer.

## Q4 resolution and decision-path review

Q4 previously occurred when an ACK guard correctly rejected a commit during abort, but its caller unconditionally cleared `acceptedInspection` before abort settlement could retain a release duty. The durable record remained accepted and blocked further inspections for that live leader.

The coordinator now distinguishes `authorized`, `revoked`, and `not-ours` (boolean false maps to revoked). The extension handles outcomes separately:

- **Checked:** clear the same completed local obligation; coordinator checks only the tagged generation.
- **Revoked:** never check. If the same local obligation still exists, transfer it to the retained release duty and attempt cleanup. If abort already transferred it, do not create a duplicate duty.
- **Not ours:** clear the old local obligation, not the durable replacement record. Existing message/leader/run tag guards remain in release and ACK helpers.
- **Thrown:** retain the local ACK obligation for metadata retry. Release failures retain their distinct duty with the corrected capped backoff; no aborted inspection is acknowledged.

Read actual helper and extension branches, not only handoff assertions. The unchanged G2 reproduction now passes: abort during the guarded runtime read leads to durable release, checkedGeneration 0, interrupted leader and sent count 1.

Two new independently authored cases (`final/revocation-cycle.test.ts`, H1/H2) extend that exact schedule through recovery, without expanding to unrelated fault hunting:

1. Revocation → metadata release while paused → formal E2 → direct resume → fresh E2 inspection with a new message ID → genuine accepted normal settlement checks E2. No extra inspection after checking.
2. Same cycle with repeated real release-rename failures. Duty survives multiple failures, remains unchecked and paused, later storage recovery releases it; E2 remains intact and its fresh normal inspection checks successfully.

Both pass. Evidence: `/tmp/pi-teams-quiescence-review/final/{G2.json,H1.json,H2.json,logs/guard-three.log,logs/revocation-cycle.log}`. No assertion weakening or reruns.

## Q1–Q4 history (preserved evidence)

- **Q1, original High:** transient abort-release rename failure discarded cleanup responsibility. Retained release duty repaired it. Original suite changed from 2 passed/1 failed to 3/3. F1 covers repeated paused failures/E2; F3 covers stale release against a replacement durable record.
- **Q2, original High:** ACK passed an early lease check, waited on coordinator lock, then checked after lease replacement (F4) or after later abort revoked its retry (F5). Guard inside coordinator lock repairs these original schedules. F4/F5 stay unchecked. G1 checks legitimate delayed E1 without consuming E2; G3 verifies replacement committed by the runtime-lock owner wins before guard reads.
- **Q3, Low:** retry scheduler was called while `inFlight` remained true, so the promised timer never armed. Finally now clears that flag before scheduling. F2 independently verifies the second attempt at 100 ms. Polling had already provided recovery; this was pacing, not permanent loss.
- **Q4, High:** guard rejection discarded cleanup responsibility. Distinct outcomes and revoked-duty handoff now repair G2 and H1/H2 as described above.

Historical checks, not current results: Task 17 full 310/26 + tsc/diffcheck passed; original independent 2/3 exposed Q1. Task 19 full 315/26 + tsc/diffcheck passed; original 3/3, F1–F6 3/6 exposed Q2/Q3. Task 21 full 320/26 + tsc/diffcheck passed; original3 and focused6 passed, G1–G3 2/3 exposed Q4. Historical fixtures, logs and observations are retained unchanged under the review root, `followup/`, and `followup2/`.

## Final independently executed checks

CWD `/home/liontree/pi-teams`. Every command below ran **once** in Task 23. Exact argv/exit files and logs: `/tmp/pi-teams-quiescence-review/final/logs/`.

| Actual argv | Exit | Observed result / log |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run` | 0 | **26 files / 325 passed**; `full.log` |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | `typecheck.log` |
| `git diff --check` | 0 | `diffcheck.log` |
| `node node_modules/vitest/vitest.mjs run --config /tmp/pi-teams-quiescence-review/vitest.config.mjs` | 0 | Original unchanged **3/3**; `original-three.log` |
| `node node_modules/vitest/vitest.mjs run --config /tmp/pi-teams-quiescence-review/followup/vitest.config.mjs` | 0 | Unchanged **F1–F6 6/6**; `focused-six.log` |
| `node node_modules/vitest/vitest.mjs run --config /tmp/pi-teams-quiescence-review/followup2/vitest.config.mjs` | 0 | Unchanged **G1–G3 3/3**; `guard-three.log` |
| `node node_modules/vitest/vitest.mjs run --config /tmp/pi-teams-quiescence-review/final/vitest.config.mjs` | 0 | New **H1/H2 2/2**; `revocation-cycle.log` |

Thus the final pass ran 325 repository tests and 14 reviewer tests, all passing, plus actual typechecking and diffcheck. Separate unit/extension runs were not additionally executed; their 19/21 cases are included in the full suite.

Node environment: `HOME=/tmp/pi-teams-quiescence-review/final/home`, `PI_AGENT_DIR=/tmp/pi-teams-quiescence-review/final/agent`, `NODE_OPTIONS=--require=/tmp/pi-teams-quiescence-review/final/guard.cjs`, `NPM_CONFIG_OFFLINE=true`, `NPM_CONFIG_UPDATE_NOTIFIER=false`. Reviewed guard reused with only isolated root changed. Guard bytes before/after **0/0, delta 0**. It denies real `~/.pi` mutations, network and non-allowlisted child processes with narrow known test-hook exceptions. It is application-level protection, not a kernel sandbox. Installed SDK verified **Pi 1.1.0**. No provider, Pi CLI, network, settings or reload experiment.

All shared original/F/G observation files were saved, fresh outputs captured under `final/`, and historical bytes restored in `finally`. Three old fixture files remain unchanged. SHA-256 proof: `final/historical-hashes.json` and `final/proof-after.json`. Original fixture remains `572dd3e7b363d344e0c567325253bcede424cdf08365cb7a4a9e8bc47a25c0a0`; G fixture remains `70bbf2c12b51265c75e69e29ab6e807574ab6c16540095d71d32204eca4c2a35`.

## Source/branch integrity

Task 17 verified the clean core git tree against all 77 baseline paths, lengths and hashes, including exact path-set equality. This old core audit was not repeated. References remain unchanged:

- core and feature HEAD: `63c075b3f202306319c3ee9945ed8e1b99a3bc77`;
- original published trial: `f1265323ba7d8d75267620d302d4252497f22346`;
- feature remains uncommitted; original historical core audit was not edited.

Author Q4 manifest checked before/after this final pass; all implementation/test/doc files match. Only this reviewer-owned report subsequently changed. Current fingerprints:

- `extensions/index.ts`: `a475e507dee33630a1a7a9a497d2ad37d8a94736838ca146a4a2d9eefb294451`
- `src/utils/quiescence.ts`: `18b939bb7017c3e19f3e9ea6c04d492d68cf7768b0b3680535b43e0ff5765256`

Complete manifest/reference/guard/history proof: `final/source-before.json`, `final/proof-after.json`. Fresh reviewer evidence is confined to `final/`.

## Explicit limitations

Guard lock order is coordinator → runtime, already used by admission. Runtime callbacks reviewed perform synchronous local work and do not await coordinator operations; no reverse runtime → coordinator wait was found in those paths. G1/G3 exercise controlled runtime-lock blocking. This is source reasoning and single-process lock scheduling, **not** a real multi-process deadlock/atomicity proof. Runtime lock is released before the coordinator write; cross-file snapshots are not globally atomic.

Inherited host fixture invokes installed `AgentSession.sendUserMessage`, `runAgentLoop` and `ExtensionRunner`, but overrides prompt execution and manually emits settlement after a fake provider throws. It does not establish a full successful real-host/UI lifecycle. Race tests use registered handlers, actual files/locks and fake timers, not concurrent real Pi processes.

Release duties remain in-memory. Process end loses them; different-leader restart handling is source-reviewed but not freshly exercised. No actual UI/restart/multi-machine validation or exhaustive retag, snapshot-to-append, late-acceptance and local-obligation-supersession matrix. This approval does not claim semantic completion, exactly-once delivery across restarts, or automatic finishing of every task.

Runtime observed as `openai-codex/gpt-6-astra`; no model/thinking switch. Medium requested, but runtime thinking level was not independently observed.
