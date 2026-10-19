# Independent audit: roster-preserving close, resume, and confirmed deletion

Date: 2026-10-19

Auditor: `openai-codex/gpt-6-astra`, thinking `xhigh`. Independent review; no implementation or repository test edits.

## Scope and evidence

Reviewed the **uncommitted** working tree on `feat/team-quiescence-check`, based on HEAD `403e0549bbd7e1bb795850ca12b477ac523d01a9`; origin remained `623671e3b83e95187d8113fd46bb62b92e79fe2d`. Included the close/resume/shutdown commands and tools, runtime/session restoration, stop notices, prompts/docs, and the accompanying `team_set_model` and `team_wait` changes.

Audited `extensions/index.ts` SHA-256: `434b1ca43031d1e4eb53073e05a5d47f151eaf0c8d9ce159c0eccd7729970683`.

All test runs and mutations were isolated in `/tmp/pi-team-close-audit-bZNq1g/`, with copied dependencies, isolated HOME/agent/session directories, and team/terminal environment hints removed. No installs, commits, pushes, real provider calls, Pi CLI launches, live tmux operations, or live-session reloads were performed. The existing SDK tests use fake provider streams. Only this report was created in the repository.

Evidence retained under `/tmp/pi-team-close-audit-bZNq1g/evidence/`:

- `audited.diff`: initial complete tracked working-tree diff.
- `baseline-tests.log`: **32 files / 437 tests passed** (`npm test`, 30.57 seconds).
- `typecheck.log`: **passed**, `npx --no-install tsc --noEmit`.
- `diff-check.log`: **passed**, `git diff --check`.
- `auditor-repros.log`: unchanged implementation, four defect repros failed their required-behavior assertions; four additional correctness cases passed.
- `extra-positive-checks.log`: five additional correctness cases passed, including the pending-launch expected-stop guard.
- `model-extra.log`: successful model-tool switch on an interrupted peer passed.
- `run-mutations.py`, `mutations.json`, `M01-*.log` through `M13-*.log`: 13 single-guard mutation runs; 11 killed, two survived the author's narrower tests. Stronger independent fixtures killed both surviving mutations.

Actual validation command counts: **17 test-runner invocations** (one full suite, three focused fixture runs, 13 mutation runs), **one typecheck**. `git diff --check` was also rerun during review and after the report was written. No implementation repair was attempted.

## Verified findings

### CR-01 — P1 blocking: confirmed deletion proceeds after a failed lease compare

**Location:** `extensions/index.ts:2846-2861` (`shutdownTeam`).

`closeTeammatePanes` returns a `peer: lease changed` result when its runtime compare-and-swap fails. `performClose` correctly treats this as unfinished, but `shutdownTeam` does not inspect the result: it stops/detaches the lead and deletes the team and task directories anyway. The teammate pane has not been killed. This loses recovery membership/tasks/mail while leaving that session running, contrary to close-before-delete behavior.

**Repro:** fixture `A1` in `/tmp/pi-team-close-audit-bZNq1g/tree/extensions/auditor-close-roster.test.ts` attaches a lead and peer, creates a task, makes `replaceRuntimeInstance` return `null`, then invokes `/team-shutdown confirm`. No pane kill occurs, but the roster is deleted. The assertion that the config still exists fails (`false`, expected `true`). This is the same lease-change boundary exercised successfully for `/team-close` by the repository tests.

**Suggested fix:** return structured close outcomes and refuse deletion/detachment if any required close was not completed, including lease changes. Preserve the team/task/inbox data and report the unclosed member. Add a confirmed-shutdown lease-change regression test.

**Provenance:** the unsafe shutdown body is inherited, but the newly confirmed user-command deletion path still exposes it. It is not a defect in parsing `confirm`.

### CR-02 — P1 blocking: a failed terminal kill is reported closed and exits the lead

**Location:** `extensions/index.ts:1966-1990`, `extensions/index.ts:2100-2106`; underlying adapter behavior at `src/adapters/tmux-adapter.ts:119-128`.

The exit guard only detects the string `lease changed`. `killTeammate` unconditionally returns `closed` after calling the terminal adapter. The real tmux adapter ignores the nonzero `execCommand` result and catches thrown errors, so a failed `kill-pane` is indistinguishable from success. Bulk close then calls `ctx.shutdown()` even though a required pane remains alive. Runtime metadata has already been marked stopped/released, making a subsequent close liable to skip the still-live member as `not running`.

**Repro:** fixture `A2` uses the actual `TmuxAdapter.kill` implementation with only `execCommand` mocked to return status `1` and `stderr: "kill-pane refused"`. No real terminal command is executed. The fake pane remains alive and there is no PID file to authorize a signal. `/team-close` still invokes the lead's shutdown callback once. The assertion that the lead remains attached fails.

**Suggested fix:** make terminal closure return a verifiable success/already-absent/failure result, propagate failures through close outcomes, and gate both lead exit and deletion on success for every required pane/window. Do not leave a failed close permanently classified as stopped with no retryable cleanup state. An adapter exception alone is insufficient unless nonzero command statuses are also checked.

**Provenance:** the adapter's silent failure is inherited; the new unconditional lead-exit decision relies on that insufficient success signal. Existing tests assert that a fake `kill` was called, not that closure succeeded.

### CR-03 — P2 should fix: a later append failure duplicates an earlier stop notice

**Location:** `extensions/index.ts:1910-1934` (`reportUnexpectedStops`).

The reporter claims all losses, appends notices sequentially, then removes **every claimed ID** from `notified` if any append fails. Successfully committed earlier notices are therefore eligible again on the next poll. `appendMessage` generates another message ID, so it does not deduplicate them. This violates the one-notice-per-runtime-instance claim and can repeatedly wake the lead for one stop.

**Repro:** fixture `A3` stops two known runtime instances. The first notice append succeeds; the second fails once with a simulated transient inbox-write error. After two polls, the first member has **two** stop notices instead of one. No restart or task completion is involved.

**Suggested fix:** track progress per instance instead of rolling back the complete batch. Prefer a stable notice ID derived from the runtime instance with the existing `appendMessageOnce` primitive, plus retryable delivery state. This also avoids treating a post-commit append error as proof that nothing was stored.

### CR-04 — P2 should fix: an in-flight stop reporter recreates deleted team data

**Location:** `extensions/index.ts:976-978`, `extensions/index.ts:1911-1918`, `extensions/index.ts:2854-2861`.

Stopping the polling interval prevents future timer callbacks but does not cancel or drain an already-running `reportUnexpectedStops`. That function retains the team name across awaits and does not fence its append against shutdown. After confirmed deletion removes the directory, the delayed `appendMessage` can recreate `teams/<team>/inboxes/team-lead.json` through its recursive directory creation.

**Repro:** fixture `A4` pauses a stop-notice append before its disk write, runs `/team-shutdown confirm` on the already-stopped team, verifies the directory was deleted, then releases the append. The team directory exists again afterward; the required assertion fails (`true`, expected `false`). This reproduces a slow/blocked mailbox write, not a new dispatch.

**Impact:** confirmed deletion leaves stale team/mail residue. This repro **does not** recreate the config/roster, restore panes, or prove membership resurrection.

**Suggested fix:** fence new reporter work when deletion begins and drain/cancel already-running reporter writes before removing the directories. Validate the same team/lead lifecycle at the durable write boundary; merely clearing the interval or checking before an awaited append is not sufficient.

## Claims checked and found correct

Within the stated mocked-terminal/SDK scope, apart from the failure paths above:

- A successful single-member close preserves roster membership and does not request lead exit. Whole-team close requests lead shutdown rather than killing the lead pane.
- A teammate lease-change result on **close** does not kill the pane, does not request lead exit, and explicitly says the lead will not exit. A stale lead instance, another team's lead, an unattached conversation, and teammates are rejected by the close authorization checks.
- Missing original sessions are restored through exact saved session paths, not replacement conversations or task replay. Independent fixture `A6` verified that reopening the original lead restores a peer previously closed by name and another missing roster peer.
- Named resume after an initially unattached legacy association restores only the named peer, not all peers first (`A5`, with two missing members). Both named filtering and automatic-restore suppression were mutation-tested. A stale lead cannot spawn through command/tool resume, and a teammate cannot use the resume tool (`A8`).
- `/team-shutdown` without final `confirm` refuses before closing; valid confirmation reaches deletion. The ordinary successful deletion tests preserve Pi JSONL bytes outside the deleted directories.
- The extension registers `team_close` and `team_resume`, not `team_shutdown` or `process_shutdown_approved`. Changed prompts/skills prohibit closing or removing agents just because work finishes or they become idle.
- Windows Terminal and Zellij close refusal is tested before runtime mutation/deletion, including a late live member and a late pending launch. Already-stopped teams can be deleted with confirmation.
- Pending recovery launches are invalidated before late child admission; the child cannot claim a cancelled reservation. PID/start-token checks prevent unconfirmed SIGKILL, and intentional-stop preparation precedes an authorized signal.
- Normal unexpected-stop and live-process/missing-pane paths produce the expected notice; repeat polling deduplicates in the no-error case. Commanded pending-launch close suppresses its old instance's notice (`A9`). Reload-in-progress suppresses stop reporting (`A7`). Source inspection confirms the reporter does not restore members, complete tasks, or call formal work-generation opening.
- Mid-turn `team_create` publishes `running`; `team_wait` can enter from stale `idle`, retains instance fencing, and distinguishes disallowed same-owner activity from actual ownership loss. Removing either repair fails the new regression test.
- `team_set_model` uses the extension control channel and reports pending/applied/refused status, not a teammate model instruction. Independent fixture `A10` verified a successful tool switch leaves the teammate `interrupted`/paused, sends no teammate model message, and leaves the work generation unchanged. Existing tests cover refusal and ownership/input validation.

## Mutation-test detail and coverage gaps

Each mutation was made **only in the temporary copy**, run separately, then restored. Production `extensions/index.ts` was byte-compared with the restored copy afterward.

| Mutation | Result |
| --- | --- |
| M01 remove final-confirm guard | Author test fails |
| M02 remove single-member lead-stays branch | Author test fails |
| M03 remove lease-change exit guard | Author test fails |
| M04 remove live-lead instance comparison | Author test fails |
| M05 remove named-attach automatic-restore suppression | Author named-resume test **still passes** |
| M06 same mutation, independent two-member unattached fixture A5 | Fails: two spawns instead of one |
| M07 remove `notified` deduplication | Author one-notice test fails |
| M08 remove `expected` suppression | Author commanded-close test **still passes** |
| M09 same mutation, independent pending-launch fixture A9 | Fails: unexpected notice emitted |
| M10 remove reloading skip | Independent fixture A7 fails |
| M11 omit mid-turn running publication | Author creation/wait test fails |
| M12 reject stale idle on wait entry | Author creation/wait test fails |
| M13 remove named member filter | Independent fixture A5 fails |

The two surviving author tests are specific coverage gaps, not proof those guards are unnecessary: the named-resume test starts with an already-attached lead and only one peer; the ordinary-close path clears the runtime instance ID before the reporter sees it. The stronger independent fixtures exercise the omitted boundaries. Porting them and the defect repros into the repository would improve the regression suite, but this audit did not modify it.

## Limits and non-findings

No real terminal/UI acceptance run was authorized. Thus shutdown-callback invocation is verified, but actual shell-prompt return is not claimed. No real providers, network transport behavior, or multi-machine recovery were tested. Other crash windows and unbounded filesystem failures are not asserted as additional findings. The four findings above are backed by deterministic isolated repros, not speculation.

## Verdict

**2 P1 blocking, 2 P2 should fix, 0 P3 minor.** The 437-test baseline and typecheck pass, but required close/deletion failure semantics and stop-notice durability do not.

**not-ready**
