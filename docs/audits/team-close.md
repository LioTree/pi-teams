# Team close/shutdown — independent audit, 2026-10-17 UTC

## Verdict

**Not ready as-is.** Findings: **0 P1, 5 P2 (should fix), 1 P3 (minor)**. There is also one **verified authorization behavior requiring a policy decision**, kept separate from the defect count because the existing `team_shutdown` tool already permits it.

The ordinary tmux-shaped happy path works, and the author's reported baseline is reproducible: **30 files / 380 tests pass; TypeScript passes; `git diff --check` passes**. Those results do not establish the stronger safety/concurrency/platform claims. Additional isolated characterization tests reproduce the issues below without killing any real process or user pane.

No implementation, existing test, or pre-existing documentation was changed by this audit. This report is the only new repository artifact.

## Identity, scope, and reproducibility

- Auditor: `close-auditor`, independent of the author; model **`openai/gpt-6.1-sol`**, thinking **`xhigh`**.
- Repository: `/home/liontree/pi-teams`, branch `feat/team-quiescence-check`, HEAD `d109e682bc40e752c9bdd003f219acb6c3c9b22c`.
- Scope: the uncommitted `/team-close` and `/team-shutdown` commands, extraction of shared `shutdownTeam`, `extensions/team-close.test.ts`, and the related changes in README, guide, reference, changelog, AGENTS, and team skill. Existing runtime/recovery/adapter code was examined only where these commands depend on it.
- Line numbers refer to that working tree. Relevant source SHA-256:
  - `extensions/index.ts`: `415ea713710e99b1324e681f8db108b708ba9054439771edc3e4c368413feef7`.
  - `extensions/team-close.test.ts`: `fc66cc96f8709e6064123fb89d831f5b93710f95f5c811c8adf84dddd6670132`.
- Test snapshot and logs: `/tmp/pi-teams-close-audit-7tqUmB/`. Implementation and original close-test hashes match the repository. All test HOME, agent directory, and session storage were redirected under this temporary root. Terminal adapters were mocked, except for explicitly called no-op Windows/Zellij kill methods; every test capable of reaching `SIGKILL` intercepted that signal. No Pi CLI, real providers, network requests, live team pane operations, installs, commits, pushes, or reloads were used.
- Background runners used only this auditor conversation's own task windows, which were not team/user panes.

### Actual validation commands and results

Commands below ran in the isolated snapshot, with its environment set by `run-baseline.sh` / `run-repros.sh`:

| Command | Final result | Artifact |
| --- | --- | --- |
| `./node_modules/.bin/vitest run --reporter=verbose` | 30 files, 380 tests passed; exit 0 | `baseline-vitest.log` |
| `./node_modules/.bin/tsc --noEmit` | exit 0 | `baseline-tsc.log` |
| `./node_modules/.bin/vitest run extensions/audit-close-repro.test.ts --reporter=verbose --hookTimeout=30000` | 21 tests passed; exit 0 | `repros-vitest-final.log` |
| `node node_modules/vitest/vitest.mjs run extensions/audit-close-platform.test.ts --reporter=verbose` | 2 tests passed; exit 0 | `platform-vitest.log` |
| `git diff --check` in the original repository | exit 0 | checked directly |

The 21-test characterization file contains the 4 copied original tests plus **17 additional cases**. The platform file contains **2 additional cases**. These are not 23 new regression tests in the repository: both files exist **only under `/tmp`**. A passing characterization test means the described behavior was observed, including defects; it does not mean the implementation is fixed.

Attempt accounting: the baseline Vitest and TypeScript commands were each invoked twice (the first task environment lacked Node in PATH, both exited 127 before checks ran; the retry passed after explicitly setting the installed Node path). The 21-test file ran twice: first 19 passed and 2 timed out in `afterEach`, because shutdown from an unrelated session leaves two original fixture sessions whose cleanup each waits on a deleted config parent; increasing only the test hook timeout to 30 s made all 21 pass. Its original log remains `repros-vitest.log`. The 2-case platform command ran once. The successful final PID-token characterization explicitly uses a persisted stale token, not merely an unavailable token for the same process.

## Verified defects

### C1 — P2: shutdown does not use close's already-stopped/dead/detached skip semantics

**Locations:** `extensions/index.ts:2416-2417`, compared with `:1365-1370`; terminal dispatch at `:1685-1690`. Documentation: `docs/reference.md:349-351`, `README.md:196-198`, `CHANGELOG.md:21`, `AGENTS.md:91`.

`/team-close` checks runtime presence, `detached`, activity, and process liveness before calling `killTeammate`. `shutdownTeam` calls that helper unconditionally for every roster member. The helper skips the canonical lead name, but otherwise still calls `killWindow` / `kill` even for an already stopped, detached, or dead member.

**Reproduction:** the three `shutdown re-kills the terminal target for an already ... peer` cases set each of these states, invoke `/team-shutdown`, and observe `adapter.kill("%peer")`. The corresponding three `/team-close` cases correctly make no adapter call and report `not running`.

**Impact:** the new shutdown command is not the approved/documented "same close, then delete metadata" operation. It can act on stale terminal IDs for members that close deliberately refuses to target. The shared helper's behavior is inherited from the old tool, not a newly introduced change to that tool; exposing it as equivalent to the new close command creates the contract mismatch.

**Suggested fix:** share a bounded close operation, including its skip rules and per-member outcome reporting, between the command and shutdown path; only then perform dissolution. Add stopped/dead/detached shutdown cases. Merely changing the documentation would not satisfy the approved same-close behavior.

### C2 — P2: close leaves a pending recovery pane open and allows its pre-close child to attach afterward

**Locations:** `extensions/index.ts:1362-1372`; interaction with `src/utils/team-session.ts:228-250,263-282` and `:137-138`.

Restoration records a nonce-bound launch and returns after `terminal.spawn`, before the child necessarily claims its runtime. During this interval, the runtime can still describe the previous dead/stopped process. Close considers only that runtime, reports `not running`, and does not reconcile or cancel the pending launch. Nothing invalidates the child's pre-close recovery token.

**Deterministic reproduction:** `a pending restoration launch is skipped by close and its child can attach afterward`:

1. Start with a confirmed saved peer session and a dead/stopped peer runtime.
2. Run the real `restoreTeamPanes` against a fake terminal; it returns `restored`, records `phase: "launched"`, and supplies a pane ID/token. Do not register the child yet.
3. Run `/team-close`. It reports `peer: not running` and performs **no terminal kill**; the pane from step 2 remains open.
4. Call the real `claimSession` with that original token/session. It successfully admits `instanceId: "late-child"`, activity `idle`, **after close has returned**.

No new post-close `/team-resume` or original-lead startup is required. This models an actual restoration process launch whose session registration is delayed, rather than probabilistically racing real panes.

**Suggested fix:** coordinate close with the existing config/runtime launch protocol, reconcile nonce-owned pending launches, and invalidate only the outstanding pre-close launch authority so late children cannot reattach. Preserve roster and saved conversations so a later explicit restore can create a fresh reservation. The exact fencing mechanism needs design agreement; do not equate suspension with member removal or a formal work-generation change.

### C3 — P2: destructive PID validation fails open when the current process-start token cannot be read

**Locations:** `extensions/index.ts:1672-1677`; `src/utils/runtime.ts:279-296`.

The helper requires a stored start token but validates the current PID through `isRuntimeProcessAlive`. That monitoring predicate deliberately returns true when signal 0 succeeds and `getProcessStartToken(pid)` returns `undefined`. Consequently an **unverified current process** can receive `SIGKILL` even though the stored start token belongs to a previous process using that PID.

**Reproduction:** `a matching PID with an unreadable current start token is still sent SIGKILL` sets the runtime to the test PID with a deliberately stale start token, writes the same numeric PID to `peer.pid`, makes only `/proc/<pid>/stat` reads fail with `EACCES`, and intercepts `process.kill`. `/team-close` reaches `process.kill(pid, "SIGKILL")`. No real destructive signal is sent.

Known, readable **mismatched** tokens and mismatched PID files are correctly rejected by separate positive-control tests. It is specifically the unavailable-current-token branch that fails open. This is an inherited helper issue exposed by the new command, not a claim that a real unrelated process was killed during this audit.

**Suggested fix:** use a stricter predicate for destructive signaling: require a nonempty recorded token and a successfully read equal current token, otherwise skip PID signaling/report identity unconfirmed. Keep conservative monitoring semantics separate, so hardening kill does not accidentally make healthy members appear dead throughout the system.

### C4 — P2: losing the runtime compare-and-swap still kills the stale target and reports success

**Locations:** `extensions/index.ts:1655-1664,1685-1690,1370-1371`; `src/utils/runtime.ts:243-246`.

`killTeammate` captures a runtime instance, calls `replaceRuntimeInstance`, and ignores both a `null` return and thrown errors. It then continues with PID/terminal destruction. `null` is exactly what the CAS API returns if a replacement instance acquired the lease while the call waited. A same-process reload is one legitimate way instance ownership can change.

**Deterministic reproduction:** `a lost runtime CAS does not stop close from killing the stale terminal target` replaces the peer runtime with a new `idle` instance at that dependency boundary and returns `null`, modeling the real API's lost-CAS result. Close still calls `adapter.kill("%peer")` and reports `peer: closed`; the durable replacement runtime remains **idle, not stopped**.

**Impact:** the promised "mark runtime stopped, then kill" ordering is not established when ownership changes or the write fails. The captured terminal IDs are used after losing authority over the captured lease, and success is reported despite the stopped transition never committing. This is inherited shared-helper behavior, now part of close's safety contract. The reproduction proves the bad failure branch, not the frequency of a real close/reload overlap.

**Suggested fix:** treat CAS loss/write failure as a non-success outcome. Abort stale targeting or re-read/reconcile the current member/lease under the appropriate locks, and only report `closed` after the intended stopped transition succeeds. Preserve stopped/replacement-wins semantics during reload and interruption; do not erase a new owner's lease based on an old snapshot.

### C5 — P2: supported tokenless/no-op adapters can leave every process running while close reports `closed`

**Locations:** `extensions/index.ts:1672-1690,1370-1371`; `src/utils/runtime.ts:279-280`; `src/adapters/windows-adapter.ts:199-206,291-297`; `src/adapters/zellij-adapter.ts:42-45`.

On non-Linux hosts no process-start token is produced, so the helper intentionally does not send `SIGKILL`. Windows Terminal's `kill` **and** `killWindow` are no-ops. Zellij's `kill` is likewise a no-op, assuming the child process exits by another means. Thus Windows Terminal, and Zellij on a tokenless host such as macOS, have **no effective stop action** here. Close still revokes the runtime instance, writes `stopped`, and announces `closed` while the process/pane remains live.

**Reproduction:** the 2-case `audit-close-platform.test.ts` simulates tokenless status and invokes the real adapters' no-op kill methods, with all destructive signals intercepted. Both cases observe no SIGKILL, the live process remaining, runtime `stopped`, and notification `peer: closed`. This is code-path verification on Linux, not a Windows/macOS end-to-end test. No real terminal APIs are invoked by these no-op methods.

**Impact:** a member may still be executing busy work after a successful-looking suspension. The new documentation advertises the command without restricting terminal support, while README explicitly lists Windows Terminal as supported. The adapter limitation pre-exists this change, but it invalidates the new universal close guarantee.

**Suggested fix:** either provide a safely identity-verified effective stop capability for these backends, or reject/report unsupported closure **before revoking their runtime lease**. Document backend limits. Do not remove process identity safety checks merely to make tokenless SIGKILL possible.

### C6 — P3: the four new tests substantiate only a subset of the stated guarantees

**Locations:** `extensions/team-close.test.ts:70-77,82-95,97-115,119-126`.

The fixtures intentionally remove `peer.pid`, so all four tests bypass the entire destructive PID-validation branch. The close preservation test checks config/runtime presence and roster length, but never seeds/verifies tasks, inbox, session bytes, or work-generation state. The shutdown test seeds a task and checks peer history, but never creates the inbox whose absence it later asserts. No original case exercises recovery launch interleaving, lost CAS, close vs reload, a separate window, a tokenless backend, or unrelated-session/named-team authorization.

These are limits of the **four new tests**, not a claim that the other 376 tests provide no runtime/recovery coverage. All four pass with C1–C5 present.

**Suggested fix:** add targeted regressions for the findings, mock destructive signals rather than deleting their input path, seed preservation/deletion artifacts before asserting them, and assert the lead's actual pane/window targets are never dispatched. The `/tmp` characterization tests demonstrate safe test techniques but currently assert observed defects; convert them to intended-behavior assertions before adding regression coverage to the repository.

## Verified authorization behavior — policy decision required, not counted as a new regression

### Q1: does "lead only" mean this team's authenticated lead, or any non-teammate operator?

**Locations:** `extensions/index.ts:1358-1362,1381-1384,2406-2409`; existing tool delegates to the same helper at `:2447`.

Verified behavior:

- An attached lead can provide **another team's name** to `/team-close` and kill that team's peers, with no target-team lead-lease/session check.
- An unrelated persistent Pi conversation which is not attached to any team defaults to a non-teammate role after `session_start`. It can invoke `/team-shutdown <existing-team>` and delete that team's roster/tasks/inbox, even while the real target lead is alive.
- The existing `team_shutdown` **tool does the same**. The command extraction retains its guard and behavior; this is not newly introduced authorization weakening in the tool.
- Actual mapped teammates are rejected by both commands as documented. Omitting the argument correctly selects the caller's attached team.

The attached-other-team close case and both unrelated-session shutdown forms are passing isolated characterizations. They do not require forged PID/session metadata.

The approved phrase "lead only" is not precise enough to decide whether this inherited global operator behavior is intentional. **Do not silently choose a policy while fixing the other findings.** If ownership is intended, validate the target team's exact saved lead session and current runtime lease, consistently for commands and tool; if non-teammate global control is intended, document that explicitly instead of implying target-team ownership. This audit did not implement either policy.

## Claims checked and found correct (within the qualifications above)

1. **Ordinary canonical lead exclusion:** `/team-close` skips both `agentType: "lead"` and the name `team-lead`; `killTeammate` itself returns for the canonical lead name. An explicit fake lead pane/window target was never dispatched, and close did not stop the lead runtime. This does not prove arbitrary stale/reused terminal IDs belong to their recorded members.
2. **Close's stopped/detached/dead gate:** each of the three states is skipped without an adapter kill and is reported `not running`. The shutdown discrepancy is C1.
3. **Correct PID-file/known-token negatives:** mismatched numeric PID files do not cause SIGKILL; a readable known-wrong start token causes close to skip the member. The unavailable-current-token hole is C3.
4. **Ordinary preservation:** with seeded task, unread inbox, both session files, and an already-checked quiescence generation, close preserves their bytes. Roster membership remains; runtime and pid-file changes are the intended exceptions.
5. **Later normal recovery remains possible:** after modeling successful terminal process death in the fake adapter fixture, `/team-resume` launches the same saved peer conversation, with its original session file, without task replay. This is not a real tmux/provider end-to-end run. The pending pre-close launch hole is C2.
6. **Interrupted state:** a real aborted-settlement handler publishes `paused: true`; close retains that bit while changing activity to stopped. Source review also confirms a `reloading` live record is eligible for close rather than incorrectly skipped solely because it is reloading. Concurrent instance replacement is not fenced correctly (C4).
7. **Work-generation/task semantics:** neither new command opens a formal work generation or marks a task complete. The seeded checked generation stays byte-identical through close and explicit restore. The existing lead poller remains attached after close and may still deliver an already-armed fault inspection; close is not a guarantee that the lead receives no future notifications.
8. **Shutdown data/history:** the ordinary attached-team path deletes team/task directories and leaves Pi session files outside them unchanged. It stops the poller, clears `teamName`, and removes the lead status display. Shared helper extraction preserves the tool's ordinary behavior. Unattached/other-team shutdown intentionally does not detach the caller from an unrelated current team.
9. **Documentation's happy path:** busy runs are not awaited, close is suspension rather than member removal, shutdown is destructive metadata dissolution, original saved conversations remain manually resumable, and omitted names use the attachment. The same-close claim (C1), universal backend support (C5), and ownership wording (Q1) need attention.

## Explicit limitations / non-findings

- There was no actual SIGKILL, real teammate close/shutdown, provider request, or real Windows/macOS terminal execution. Claims above distinguish real storage/helper execution from mocked OS/terminal boundaries.
- Arbitrary pane/window-ID reuse or a user moving the lead into a teammate's window can make name-based exclusion insufficient; no end-to-end stale-ID collision was reproduced. This is a residual terminal-identity risk, **not an additional verified finding**.
- General crash consistency of old cleanup code, unrelated recovery features, and older audit records are outside scope. Existing files in `docs/audits/` were not edited.
- The user's ownership/fencing/platform policy choices remain with the user/lead. This audit supplies findings and evidence, not an implementation mandate chosen on their behalf.

---

## Re-audit — 2026-10-17 UTC, after the confirmed policy fixes (task 3)

### New verdict and scope

**NOT READY: 0 P1, 3 P2, 2 P3 remaining findings.** The fixes materially improve the commands and resolve the first report's ordinary authorization, skip, pending-pane fencing, destructive-token, direct-close CAS, and static unsupported-terminal cases. The remaining findings below are new conclusions about the revised tree, not changes to the historical report above. Q1 is no longer an open policy question: the user chose the live lead of the target team, and refusal before writes when an unsupported terminal has a teammate needing closure.

Auditor remains **`close-auditor`, `openai/gpt-6.1-sol`, thinking `xhigh`**. Independently inspected `/home/liontree/pi-teams`, branch `feat/team-quiescence-check`, HEAD `d109e682bc40e752c9bdd003f219acb6c3c9b22c`, including the current uncommitted implementation, tests, and all six requested policy-documentation files. Line numbers below refer to this revised tree. No implementation/test/documentation file other than this appended audit section was edited. The historical report is exactly **19,912 bytes**, SHA-256 `4fe0998f8b7e6126af01de5660c853e1df136ccec0c440b771458e855e98e0d5`; that complete prefix was preserved byte-for-byte.

Fresh SHA-256 values, independently taken before and after validation:

| File | SHA-256 |
| --- | --- |
| `extensions/index.ts` | `66f0892d12ac4354120f4139ee875fc4f5a52a32807a1ab33c60ce4a9cd4249b` |
| `extensions/team-close.test.ts` | `9c10066875fdbb1c01f56912d10204d0e25163fc8bd98842bacfc518fce808ff` |
| `src/utils/runtime.ts` | `c0b021520bcbe34fcab437480f407e397cead5bf2201cf21fca1604b07670843` |
| `src/utils/team-session.ts` | `cd0a14a79979258f556917f53d9d4d20537a3dd00f5e4971cd05642889dc30fe` |
| `src/utils/member-launch.ts` | `5a3c793f9f335bb8d9ddb5e28bc6f433b4d9cdadb197c3f604ef5dd6fa4cc8a0` |
| `src/utils/terminal-adapter.ts` | `455b48f62792f3f46d3f966725d6c0eab3e3befb491b647e6f04ff07da73d15b` |

### Fresh commands, artifacts, and actual counts

New snapshot/log root: **`/tmp/pi-teams-close-reaudit-TcHpCZ/`**, separate from the first audit. The implementation and original close tests were copied before baseline execution; the supplemental tests were added only afterward. `HOME`, `PI_CODING_AGENT_DIR`, and Pi session storage were redirected under this root; inherited team/session/tmux identity variables were unset in every runner. Node's installed bin directory was explicitly put in PATH. No install, network, Pi CLI, real provider, real destructive signal, live-lead reload, or team/user pane operation was performed. Only this auditor's own managed background-task windows were used.

| Command in the isolated snapshot, unless noted | Observed result | Log/script under the new root |
| --- | --- | --- |
| `./node_modules/.bin/vitest run --reporter=verbose` | **30 files / 387 tests passed**, exit 0 | `baseline-vitest.log`, `baseline.sh` |
| `./node_modules/.bin/tsc --noEmit` | exit 0 | `baseline-tsc.log`, `baseline-status.log` |
| `./node_modules/.bin/vitest run extensions/audit-close-reaudit.test.ts --reporter=verbose --hookTimeout=30000` | **43 tests passed**, exit 0, final run | `proofs-vitest-final.log`, `proofs.sh` |
| `./node_modules/.bin/vitest run extensions/audit-close-empty-platform.test.ts --reporter=verbose --hookTimeout=30000` | **6 tests passed**, exit 0 | `empty-platform.log`, `empty-platform.sh` |
| Eight independent `/tmp` source mutations; focused original tests for M1–M7, all original close tests for M8, then supplemental ownership tests for M8 | Seven mutations killed by expected assertions; M8 survived all 11 original close tests but failed the 3 supplemental stale-lead cases | `mutations.py`, `mutation-status.log`, `M1-auth.log` through `M8-instance-ownership-supplemental.log` |
| `git diff --check` in the original repository | exit 0 | independently checked before and after the append |

These are **49 unique supplemental cases**, not repository test additions. Of the 43-case file, 35 check intended behavior and 8 deliberately characterize remaining defects. Passing those eight means the bad behavior was reproduced, not fixed. The six additional platform cases verify the approved no-close-needed exception and its documentation mismatch.

Attempt accounting: baseline Vitest once, TypeScript once, the 43-case file twice, the 6-case file once, and nine Vitest invocations across eight mutation trees: **13 Vitest invocations total**. The first supplemental run had 41 passes and 2 fixture failures: a spy on the default `fs.rmSync` object did not intercept the implementation's namespace-imported deletion call, so two pre-deletion observations remained undefined. Only the temporary observation hook was changed to intercept the lead's stopped-status update immediately before deletion; the complete 43-case rerun passed. The initial log is retained as `proofs-vitest.log`. Mutation exit 1 values are expected guard-detection results, not failures of the unmodified tree.

### Remaining findings

#### R1 — P2: other `killTeammate` callers discard `lease-changed`, falsely report shutdown, or launch a duplicate

**Locations:** `extensions/index.ts:1730-1735`, `:2026-2029`, `:2064-2080`, `:2619-2625`.

The helper now correctly returns `"lease-changed"` without targeting the pane when its runtime CAS loses. `closeTeammatePanes` handles that result, but `process_shutdown_approved` and `delegate_task(reuse="replace")` still ignore it.

**Deterministic reproductions:** the two `R1:` cases in `audit-close-reaudit.test.ts` attach a live peer, remove its pid file for safety, and make the real helper's `replaceRuntimeInstance` dependency return `null`, exactly its documented lost-CAS result:

- Shutdown approval removes roster membership, leaves the peer runtime **idle**, makes **no adapter kill**, yet returns **`has been shut down`**.
- Replacement makes **no adapter kill**, deletes the old member, allocates another conversation, overwrites the live runtime with **`starting` / undefined PID / a different instance identity**, and requests a replacement launch through the fake adapter. The response says `spawned: true`; the original live process was not closed. No real second process was started by this audit, but the production launch path is reached.

This is an incomplete migration to the stricter helper's new return contract. It can orphan a live member and start another process with the same member name, not merely produce cosmetic output.

**Fix:** audit every helper caller. Replacement must abort/reconcile on `lease-changed` before deleting the member, erasing its lease, creating replacement work, or spawning. Approval must preserve its intentionally durable removal-before-cleanup policy, but report cleanup incomplete/lease changed rather than falsely claiming a kill succeeded; do not restore removed membership just to repair the message. Add both caller-level lost-CAS tests.

#### R2 — P2: pending window-only launches are marked closed without closing their window

**Locations:** `extensions/index.ts:1678-1682,1705-1711`; valid producer at `src/utils/member-launch.ts:34-38`.

Cancellation returns only the launched `tmuxPaneId`. The entire pending close block, including `killWindow(member.windowId)`, is gated on **`pending.pane`**. A separately launched window legitimately has `windowId` set and `tmuxPaneId: ""`: that is exactly how `launchReservedMember(..., separateWindow: true)` records it. Its launch is fenced, but its window never receives a close operation.

**Reproduction:** the three `R2:` cases install this valid launched-window shape in an isolated, not-yet-registered member, then invoke close, shutdown command, and shutdown tool. All three call **neither** `killWindow` **nor** `kill`; close still reports **`peer: closed`** and persists `phase: "failed"`. Shutdown goes on to delete the team metadata. The test uses fake terminal IDs and a launch-shaped record, not a real iTerm2 window.

**Fix:** return both pane and window targets from the locked cancellation snapshot, and handle each independently. A window-only launch must call `killWindow` without requiring a pane ID. Avoid using the older outer `member.windowId` snapshot after cancellation acquires the config lock. Keep the token fence and saved-session preservation intact. Add a pending separate-window regression for all shared entry points.

#### R3 — P2: unsupported-terminal preflight can be bypassed by a dead-to-live transition

**Locations:** `extensions/index.ts:1696-1705,1714-1719`, with writes at `:1730-1739` and dissolution at `:2494-2497`.

The capability check is performed once, from an earlier runtime/config snapshot. If every peer initially appears stopped/dead with no pending launch, the check is skipped. The later execution loop re-reads liveness and can now close a live peer, but does **not** re-check terminal capability before the stopped write. A legitimate original-session registration can occur between these reads.

**Deterministic reproduction:** the three `R3:` cases use a Windows-shaped fake adapter and controlled runtime snapshots: the preflight's first peer read is stopped/dead; subsequent reads see its live registered runtime. There is no random OS scheduling dependency. Each entry point **resolves instead of rejecting** and invokes `kill("%peer")`; close writes the runtime **stopped**, while shutdown command/tool **delete the team**. This contradicts the user's requirement that an unsupported terminal with a peer needing closure refuse before writes/deletion. It does not claim a real Windows process was killed.

**Fix:** enforce the capability precondition at the guarded execution/commit point as well as preflight, including before a newly discovered pending launch is invalidated. A state transition after preflight must not turn an unsupported operation into a durable stopped write or dissolution. Add late-registration tests; do not weaken process-identity checks or change the user's no-close-needed exception.

#### R4 — P3: original close tests do not protect the exact live-lead instance guard

**Locations:** `extensions/index.ts:1656`; `extensions/team-close.test.ts:128-150,224-230`.

The revised tests meaningfully cover several new guards, but still miss a specific ownership regression. In isolated mutation **M8**, remove only `status.instanceId === runtimeInstanceId` from `assertLiveLead`, leaving conversation, team, role, PID/liveness, and session checks intact. **All 11 original close tests still pass.** An old closure with the same saved lead conversation can then act despite another runtime instance owning the lease.

The supplemental `lost-lead-lease is refused through ...` cases keep the saved conversation unchanged, transfer the runtime instance, and assert rejection with byte-preserved peer/data state. On the correct tree all three pass; on M8 **all three fail with a resolved operation instead of rejection**. Thus this is a demonstrated test gap, not an assertion that the current source lacks the guard.

**Fix:** add stale/replaced lead-instance cases for both commands and tool, with assertions of no stopped write, no adapter operation, and no deletion. Retain the existing unrelated-session, other-team, and teammate cases; they test different predicates. Add the R1–R3 regressions rather than treating 387 passing tests as evidence for these missing boundaries.

#### R5 — P3: most docs describe unconditional platform refusal, unlike the approved conditional policy

**Locations:** `README.md:198`, `docs/guide.md:316`, `CHANGELOG.md:21`, `AGENTS.md:91`, `skills/teams.md:67`; compare the correctly qualified `docs/reference.md:351`.

Those summaries say the Windows/Zellij commands refuse and do not delete the team, without stating the exception when **no teammate needs a close**. The approved policy and implementation are conditional: an already stopped/detached/dead-only team can be closed without a terminal operation, and shutdown may then dissolve its metadata.

**Reproduction:** all six `audit-close-empty-platform.test.ts` cases set the peer already stopped and use each of Windows/Zellij with close, shutdown command, and tool. All resolve, make no terminal calls, and preserve both conversations; the four shutdown cases delete the team. This is **correct under the confirmed policy**, but contradicts the unconditional safety promise in those summaries.

**Fix:** qualify each summary consistently with the reference: unsupported terminals refuse **when any teammate or pending launch still needs closure**. Do not change the approved policy to unconditional refusal merely to match the shorthand docs.

### Claims independently re-checked as fixed or correct

1. **Q1 / target-team ownership:** 15 supplemental refusal cases cover unattached sessions, another team's lead, a duplicate window of the same saved conversation, a teammate, and a stale lead instance, each through both commands and the tool. The correct tree rejects every case without adapter targeting, peer-runtime changes, or seeded roster/task/inbox/session/generation changes. No unresolved policy choice remains here; R4 is a regression-test gap.
2. **C1 / skip parity:** nine cases cover stopped, detached, and dead peers through all three entry points. No terminal target is killed. Shutdown's ordinary path now shares close's skip logic.
3. **C2 / pane cancellation and late-child fence:** both reserved and launched records are durably failed; the old token is rejected by real `claimSession` with `superseded`. Saved peer bytes remain, and explicit `/team-resume` creates a different reservation for the exact original session without replay. This fixes the former pane-shaped reproduction; R2 is the remaining separate-window hole.
4. **C3 / destructive identity:** `hasConfirmedProcessIdentity` requires a stored nonempty token, live PID, and successfully read equal current token. The source and direct new tests confirm that unreadable `/proc` cannot produce SIGKILL. Monitoring's `isRuntimeProcessAlive` remains deliberately fail-open. The M5 mutation safely intercepts signals and proves the new regression test catches a return to monitoring-based destructive validation.
5. **C4 / direct close CAS:** the revised helper returns before pid/pane targeting on `null`, and direct close reports `lease changed` without marking the runtime stopped. Removing that branch causes the original test to fail. Remaining return-contract consumers are R1.
6. **C5 / static unsupported terminals:** six supplemental Windows/Zellij cases exercise both commands and tool with a live peer. They reject before peer/lead runtime changes, seeded data changes, or deletion. The adapters explicitly advertise no close capability. R3 is the subsequent state-change hole; R5 is the documented no-work exception.
7. **C6 / meaningful tests, not just green tests:** M1 authorization, M2 stopped-peer skip, M3 durable cancellation, M4 stale-token admission fence, M5 destructive identity, M6 CAS return, and M7 platform preflight each cause the appropriate original assertion to fail when removed. M8 is the explicitly surviving narrower guard mutation. No mutation touched the repository.
8. **Lead exclusion and preservation:** the seeded close case gives the lead explicit pane/window IDs, preserves its runtime bytes, and dispatches only the peer pane. Seeded config/roster, task, unread inbox, both Pi sessions, and checked quiescence state stay byte-identical through ordinary close; interrupted `paused: true` survives the stopped transition. A pending cancellation intentionally changes its recovery metadata, not roster membership or conversation bytes.
9. **Shutdown storage/task semantics:** both shutdown forms remove seeded team/task/inbox data and retain both saved conversations unchanged. Immediately before deletion, task status/ownership and generation bytes remain unchanged: no completion and no formal dispatch. The lead pane/window is not killed. Shutdown does publish the lead stopped before deleting team runtime metadata and detaching, as dissolution requires; this is not a claim that its runtime file persists afterward.
10. **Documentation check:** all six requested docs were checked against current source and the confirmed policy. Target-team ownership, stopped/dead/detached skip, normal pending-pane fencing, strict PID identity, suspension versus dissolution, and retention semantics now agree in the ordinary path. R2/R3 remain stronger advertised guarantees not fully implemented, and R5 is the remaining conditional-policy wording mismatch.

### Re-audit limits

No Windows/macOS/iTerm2 end-to-end execution, real close/reload race, real SIGKILL, or real member replacement was performed. Dependencies were controlled at the exact runtime/config/adapter boundaries, with actual team/session/task storage under `/tmp`. The tests prove specific branch outcomes, not the real-world frequency of those races. The 387-test baseline was independently re-run on the newly hashed tree, not carried over from the first report. Fixes remain the author's task; this re-audit only appends evidence and a **not-ready** verdict.

---

## Re-audit — 2026-10-18 UTC, after R1–R5 fixes (task 4)

### Verdict

**NOT READY to close the requested regression-test-effectiveness gate: 0 P1, 0 P2, 1 P3 (test coverage).** No implementation defect was reproduced in the unmodified current tree. The previous R1–R5 behavior and documentation findings are fixed in the cases independently re-tested below. The sole remaining finding is that deleting one necessary safety guard still leaves **all 394 repository tests green**. That prevents an unqualified claim that the requested guard-removal check passed; it is not a claim that the guard is absent or broken in current source.

### Identity, fresh snapshot, and unchanged history

- Auditor: **`close-auditor`, `openai/gpt-6.1-sol`, thinking `xhigh`**; neither model nor thinking was changed.
- Repository/branch/HEAD: `/home/liontree/pi-teams`, `feat/team-quiescence-check`, `d109e682bc40e752c9bdd003f219acb6c3c9b22c` plus the current uncommitted tree.
- New isolated copy and evidence root: **`/tmp/pi-teams-close-task4-fnz7ldjy/`**. The initial `source-manifest.json` independently hashes all 94 copied repository files, including the untracked close tests. All original repository files still matched it immediately before this append. No prior count or hash was used as proof of this tree's result.
- Previous report length: **37,141 bytes**, SHA-256 `a03bd202946bc1ebc2e5a60d9405d3cdca7997b2cb5d69241576b501a4f0bf0e`. That entire prefix, including both earlier audit sections, is preserved byte-for-byte. The first report's 19,912-byte prefix is also unchanged.
- Only this appended report section was written in the repository. Supplemental tests and all mutations live under the new `/tmp` root. No install, commit, push, network, Pi CLI, real provider, real SIGKILL, live-lead reload, live user/team pane operation, or manual `~/.pi` data modification occurred. Test HOME, agent directory, and session storage were redirected under `/tmp`; inherited team/session/tmux identifiers were unset. Managed background-task windows belonged only to this auditor conversation.

Fresh source SHA-256 values, checked against the snapshot again after validation:

| File | SHA-256 |
| --- | --- |
| `extensions/index.ts` | `0f331daf7cb3d7da94de2b38f0b583466a3e3fe66f2cca5d2df722cb973a803a` |
| `extensions/team-close.test.ts` | `d09ed4b82d7a899ba62db7e77fcff9f082c3baa66ecda256be060047af9fdeeb` |
| `src/utils/runtime.ts` | `c0b021520bcbe34fcab437480f407e397cead5bf2201cf21fca1604b07670843` |
| `src/utils/team-session.ts` | `cd0a14a79979258f556917f53d9d4d20537a3dd00f5e4971cd05642889dc30fe` |
| `src/utils/member-launch.ts` | `5a3c793f9f335bb8d9ddb5e28bc6f433b4d9cdadb197c3f604ef5dd6fa4cc8a0` |
| `src/utils/terminal-adapter.ts` | `455b48f62792f3f46d3f966725d6c0eab3e3befb491b647e6f04ff07da73d15b` |

### Actual validation, counts, and mutation evidence

Commands ran from the fresh snapshot or each isolated mutant, with the installed Node directory explicitly on PATH. The baseline finished before supplemental tests were added. All paths in the last column are under the new evidence root unless stated otherwise.

| Command | Actual result | Artifact |
| --- | --- | --- |
| `./node_modules/.bin/vitest run --reporter=verbose` | **30 files / 394 tests passed**, exit 0 | `baseline.sh`, `baseline-vitest.log`, `baseline-status.log` |
| `./node_modules/.bin/tsc --noEmit` | exit 0 | `baseline-tsc.log` |
| `./node_modules/.bin/vitest run extensions/audit-close-task4.test.ts --reporter=verbose --hookTimeout=30000` | **61 intended-behavior tests passed**, exit 0 | `proofs.sh`, `proofs-vitest.log`, `proofs-status.log` |
| Eleven independent source mutations, with focused original close tests except N5's complete close-test file; then N5's supplemental final-read tests | **10 mutations killed by expected assertions; N5 survived all 18 original close tests**. The two selected supplemental tests correctly failed on N5. | `mutations.py`, `mutations.sh`, `mutation-status.log`, individual `N*.log` files |
| `vitest run <the 30 original test-file paths> --reporter=verbose --hookTimeout=30000` on N5 | **30 files / 394 tests passed**, exit 0, despite the removed final safety check | `mutant-full.py`, `original-test-selection.txt`, `N5-final-live-capability-full.log`, `mutant-full-status.log` |
| `git diff --check` in the original repository | exit 0, before and after append | checked directly |

**Attempt accounting:** 15 Vitest invocations total: one baseline, one 61-case run, eleven original-test mutation runs, one N5 supplemental mutation run, and one N5 full-original-suite run. TypeScript ran once. There were no unmodified-tree failures, fixture repairs, or retries in this round. Expected mutation failures are assertion failures, not import, compile, or timeout failures. The full N5 run explicitly selected the original 30 files so the auditor's supplemental file was not accidentally included in its 394-test count.

The 61 temporary cases all assert intended behavior; none deliberately assert a defect in the unmodified implementation. They include fresh lost-lease caller checks, pending window-only closure through all three entry points, both unsupported backends, later live/pending observations, seeded preservation/dissolution checks, original-session recovery, and exact lead-instance ownership. These are audit artifacts, **not new repository regression tests**.

| Mutant | Removed/weakened protection | Original-test outcome |
| --- | --- | --- |
| N1 | replacement caller's `lease-changed` throw | expected rejection assertion fails |
| N2 | approval caller's `lease-changed` throw | expected rejection assertion fails |
| N3 | window-only close by incorrectly requiring a pane ID | both selected window tests fail on missing `killWindow` |
| N4 | capability check inside the pending-launch config lock | late-pending rejection assertion fails |
| N5 | last live-member capability check immediately before `killTeammate` | **18/18 close tests and 394/394 full-suite tests pass**; see T1 |
| N6 | exact live-lead instance equality | new replaced-lead rejection assertion fails |
| N7 | return on direct-close runtime CAS loss | pane-not-killed assertion fails |
| N8 | strict destructive identity, reverting to monitoring liveness | intercepted `SIGKILL` violates the expected no-signal assertion |
| N9 | failed/superseded recovery-token admission fence | stale-child rejection assertion fails |
| N10 | stopped-peer skip before direct close | shutdown no-kill assertion fails |
| N11 | durable `recovery.phase = "failed"` cancellation write | expected failed-phase assertion fails |

### Sole remaining finding

#### T1 — P3: the final live-member capability guard has no effective repository regression test

**Locations:** guard `extensions/index.ts:1728`; incomplete interleaving coverage in `extensions/team-close.test.ts:298-314`, compared with the locked-pending case at `:316-341`.

The current source correctly rechecks terminal capability immediately before killing a member found live by the final runtime read. However, the new live-transition test makes **only the first peer read** appear stopped. Its next read is live, so the earlier fresh-member capability guard at `extensions/index.ts:1711-1713` rejects first. The test never needs the final check. The locked-pending case protects a different guard.

**Deterministic reproduction, only in `/tmp`:** N5 removes exactly this line, leaving the earlier checks intact:

```ts
if (!terminalClosesProcesses(terminal)) requireCloseableTerminal(action);
```

The isolated close test file still passes **18/18**, and an independently selected full original suite still passes **30 files / 394 tests**. This is a demonstrated surviving guard mutation, not an inference from reading the test.

The supplemental `late-live-at-final ...` cases make runtime reads 1 and 2 appear stopped, then read 3 live: preflight sees stopped, the fresh-member check sees stopped, and only the final runtime check discovers the live member. With the real guard present, all **six Windows/Zellij × close/shutdown-command/shutdown-tool cases reject without runtime writes, adapter calls, seeded-data changes, or deletion**. With only that guard removed, the two selected Windows/Zellij close cases resolve instead of rejecting and their assertions fail. No real terminal or destructive process signal is used.

**Fix:** add repository tests for that exact later transition, preferably covering both unsupported adapters and shared entry points. Assert refusal plus unchanged runtime/config/task/inbox/generation/session bytes and no pane/window operations. Verify that removing only the final guard makes these tests fail. The production guard is already correct; this finding requires regression coverage, **not another implementation or policy change**.

**Effect on verdict:** R1–R5 implementation verification passes. The remaining `not-ready` status is narrowly the user's requested test-effectiveness gate: the claim that the corresponding necessary guards are protected against removal is not yet true for T1. No P1/P2 implementation defect is being substituted for this P3 test gap.

### Previous findings and safety claims re-checked as fixed

1. **R1, callers honor lease loss:** replacement rejects before member removal, task creation, generation change, runtime wipe, or spawn; seeded file bytes and task filenames remain unchanged. Approval keeps the member removed, leaves the live runtime untouched, and throws that the removed member's process lease changed before it could be stopped. It does not return `has been shut down` or restore membership. Source: `extensions/index.ts:2036-2046,2632-2641`; both caller mutations fail the revised original test.
2. **R2, pending separate windows:** the cancellation helper captures pane and window IDs from the locked record independently; window-only records invoke `killWindow` without a pane ID. Supplemental close, command-shutdown, and tool-shutdown cases all close exactly the recorded window and preserve both conversations; both shutdown forms then delete metadata. Source: `extensions/index.ts:1671-1686,1714-1721`. No prior outer window snapshot is used for dispatch.
3. **R3, unsupported late live/pending states:** normal live-peer cases refuse before any observed data/runtime write. First-look transitions, final-runtime transitions, and pending records visible only inside the config lock are independently exercised. Both Windows/Zellij and all three entry points behave correctly. The locked capability check precedes the durable failed-phase write; the final live check precedes `killTeammate`. T1 is only the missing original regression test for the latter, not a failed current behavior.
4. **R4, exact live-lead instance:** the original test now really transfers the lease with `replaceRuntimeInstance`; deleting instance equality makes it fail. Fifteen supplemental unauthorized-role/entry-point combinations cover unattached, other-team lead, duplicate window, teammate, and a transferred stale instance. All reject without peer stopped writes, adapter operations, seeded data changes, or deletion.
5. **R5, policy wording:** README, guide, CHANGELOG, AGENTS, skill, and reference now qualify unsupported-backend refusal on a teammate or pending launch still needing closure; the already-stopped/no-pending exception agrees. Six supplemental no-close-needed platform/entry-point cases accept the operation without terminal calls; shutdown dissolves metadata while retaining both histories. Reference text also correctly describes window-only targeting and the two lost-lease callers.
6. **Lead, storage, and recovery:** ordinary close leaves the lead runtime bytes and explicit lead pane/window targets alone; it preserves seeded roster/config, in-progress task, unread inbox, generation, and both conversation files. Interrupted `paused: true` remains. The original recovery token is rejected after cancellation; explicit later restore uses the original conversation and a new reservation without replay. Already stopped/dead/detached peers are skipped through all three entry points.
7. **Shutdown, signaling, and work state:** both shutdown forms delete seeded team/task/inbox data while retaining both conversations. A pre-deletion observation verifies unchanged task status/owner and generation bytes: no task completion or formal dispatch. The lead pane/window is not killed; its runtime record is marked stopped and deleted as part of dissolution, while the lead session detaches. Unreadable process tokens still cannot authorize SIGKILL, monitoring liveness remains separate, and direct-close CAS loss still skips pid/pane targeting and reports `lease changed`. Fresh guard mutations verify those protections rather than relying on earlier reports.

### Limits and handoff

All concurrency/terminal boundaries were controlled in isolated tests with real temporary storage; no Windows/macOS/iTerm2 end-to-end run, real teammate kill, or real provider execution was attempted. The findings establish branch behavior and test sensitivity, not the frequency of a real interleaving. Earlier audit sections remain unchanged historical records. No fix was implemented: **R1–R5 are behaviorally verified; T1 is the sole remaining P3 regression-test item.**

### Task 4 finalization — concurrent test addition independently verified, 2026-10-18 UTC

**FINAL VERDICT: READY for the reviewed scope. Remaining findings: 0 P1, 0 P2, 0 P3. T1 is resolved.** This finalization supersedes the initial task-4 snapshot's test-gap verdict above; no earlier report text has been removed or rewritten.

At final integrity checking, `extensions/team-close.test.ts` no longer matched the initial `d09ed4...` snapshot: the author had added a final-read-only live-peer regression at `:316-337`. The lead confirmed that change and the expected new count. Completion was paused rather than applying the earlier 394-test result to a different tree. A second fresh isolated snapshot was then created at **`/tmp/pi-teams-close-task4-fnz7ldjy/revised/`**, with its own HOME, agent/session storage, and `source-manifest.json`.

The only repository changes between the two audited snapshots were the author's one test addition and this auditor's appended report. Implementation and all policy documentation are byte-identical. Fresh final hashes:

- `extensions/index.ts`: `0f331daf7cb3d7da94de2b38f0b583466a3e3fe66f2cca5d2df722cb973a803a`.
- `extensions/team-close.test.ts`: **`abd317c2fedc1f192c1391bfbd521349bcd6387faeb306b8bc6f3455d30b483b`**.
- The 50,477-byte report before this finalization: `f9ced264ad11b295c42a89e47e4cff5bbcb667dc8eaf04e1bdaafd9ceecb1eef`; this whole prefix, as well as the older 37,141- and 19,912-byte prefixes, remains unchanged.

| Additional independent command | Result | Artifact under `revised/` |
| --- | --- | --- |
| `./node_modules/.bin/vitest run --reporter=verbose` on the current unmodified tree | **30 files / 395 tests passed**, exit 0 | `validate.sh`, `baseline-vitest.log`, `status.log` |
| `./node_modules/.bin/tsc --noEmit` on that same snapshot | exit 0 | `baseline-tsc.log`, `status.log` |
| `./node_modules/.bin/vitest run --reporter=verbose --hookTimeout=30000` on a separate copy with only the final live-member capability line removed | **1 test failed / 394 passed; 1 file failed / 29 passed**, expected exit 1 | `mutate.sh`, `final-guard-mutant.log`, `mutant-status.log` |
| Final `git diff --check`, audit whitespace check, manifest/prefix comparisons | clean; immutable prefixes and all other files match | `final-validation.json`, `audit-whitespace.log` |

The sole mutant failure is now the **repository's new** `an unsupported terminal refuses a peer that is live only on the final read`, with `promise resolved "undefined" instead of rejecting`. It is the expected semantic assertion, not a timeout, compiler error, or fixture failure. Its first two peer reads are stopped and its third read is live. On the correct current tree the test successfully exercises Windows close and Zellij shutdown; on the mutant it fails at the Windows rejection assertion. The earlier supplemental matrix separately verified all six backend/entry-point combinations. Thus N5 is now detected by repository regression coverage, closing T1. Together with the ten other guard-removal failures recorded above, the requested checked guards now have demonstrated removal sensitivity.

The 61 intended-behavior supplemental cases were run once on the byte-identical implementation in the initial task-4 snapshot; they were not relabelled as a second run after this test-only addition. Task 4's cumulative actual commands are **17 Vitest invocations and 2 TypeScript invocations** across the two snapshots, with expected mutant failures distinguished from successful unmodified checks. No implementation or repository test was edited by this auditor.

The R1–R5 fixes and the preserved lead/storage/history/PID/CAS/work-generation guarantees described above remain verified. The final manifest comparison excludes only this appended audit file and matches all 93 other original repository files against the revised snapshot. The READY verdict remains limited to the inspected code and isolated tests: it does not claim real Windows/macOS/iTerm2 terminal execution, real provider execution, or a live team kill test.
