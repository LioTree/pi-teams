# /team-close lead exit — second independent audit, 2026-10-19 UTC

## Verdict

**NOT READY to land as-is: one Medium conformance gap (F1).** The requested behavior is implemented and independently verified on the happy path, every refusal path, the error path, and the recovery path; the single blocker is that the lead Pi is also asked to exit when a teammate was *not* actually closed (`lease changed`), which contradicts the delegation contract and `docs/reference.md`.

Findings: **0 High, 1 Medium, 2 Low, 3 informational**. If F1 is fixed (small change) or explicitly accepted and the affected docs/description reworded, the change is ready by this audit's evidence.

## Identity, scope, fingerprint

- Auditor: `close-exit-flash`; model **volcengine-codingplan/deepseek-v4.1-flash**, thinking **max** (as delegated; unchanged).
- Branch `feat/team-quiescence-check`, HEAD `403e0549bbd7e1bb795850ca12b477ac523d01a9`; audited subject is the **uncommitted working tree**, diff SHA-256 `b1f30bb8b5f0b965cee23542c8837447075a9ae77cb4ff939c6025fd0e5b96e1` (captured at start and re-checked identical at the end).
- Constraints observed: no commits, pushes, installs, reloads, real providers, Pi CLI, tmux against live panes, network, or `~/.pi` mutation. No implementation, test, or existing doc was edited. The only repository artifact authored by this audit is this report. Probes live only in the isolated copy `/tmp/close-audit-flash/`.
- The concurrent first-auditor report `docs/audits/team-close-lead-exit.md` appeared while I worked; it was not edited. I opened that file once while checking whether it had appeared; every finding and every probe below was then authored from a fresh read of the source and the delegation contract, and F1 was reproduced by my own failing probe (P2), not adopted from the other report.

| Audited file | SHA-256 |
| --- | --- |
| `extensions/index.ts` | `d7f810ab0e2ae71e292dfb78c7ced5d7ab132902fe8268982bbc73704bbcbe30` |
| `extensions/team-close.test.ts` | `cb0b077df7555eb5246ff877a8d0239cb904662ecac95a59c04f5b6abab88909` |
| `docs/reference.md` | `1c737fe1204a59070fa63dbcdbbc6eff3db0a7406cacdf8ca351000f273deebe` |
| Probe file (`/tmp/close-audit-flash/extensions/zz-audit2-probe.test.ts`) | `d3e862f4d862459c89cebc87df86261f98a8a4898fe259e10bde192609b3383e` |

## What the change is

`extensions/index.ts:1458-1475` — the `/team-close` handler keeps its previous guards (`sessionStopping` check, `assertLiveLead` at `extensions/index.ts:1752`, `closeTeammatePanes` at `extensions/index.ts:1806`), then shows a notify (`extensions/index.ts:1467-1472`, ending with `"Lead Pi will exit to its shell; the lead pane stays."`), re-checks `sessionStopping` (`extensions/index.ts:1473`), and calls `ctx.shutdown()` (`extensions/index.ts:1474`). `shutdownTeam` (`extensions/index.ts:2609-2646`, shared by `/team-shutdown` and the `team_shutdown` tool) does **not** call `ctx.shutdown()`.

The same uncommitted tree also adds the unrelated `team_set_model` tool (`extensions/index.ts:1371-1416` region) and its tests/docs. Per delegation that work is out of scope; it was not audited beyond confirming it does not touch the close/shutdown paths.

## Commands run by this auditor (not taken from the author)

| Check | Result |
| --- | --- |
| `npx vitest run extensions/team-close.test.ts` | **19/19 passed** (matches the author's claim) |
| `npx vitest run` (full suite) | **32 files / 432 tests passed**, exit 0 |
| `tsc --noEmit` | exit 0 |
| `git diff --check` | clean |
| Independent probe suite `/tmp/close-audit-flash/extensions/zz-audit2-probe.test.ts` | 3 invocations; 9 probes; **8 pass, 1 deliberate contract probe fails (P2) — the F1 evidence** |

## Verified behaviors and probe evidence

1. **Happy path: close, then exit request, in that order.** Probe P7 asserts `terminal.kill("%peer")` was called and `ctx.shutdown` was called exactly once, with the kill call order strictly before the shutdown call order; the peer runtime is `stopped`. The author's two positive tests (`extensions/team-close.test.ts:83-107`) also pass.
2. **Refusals never exit the lead.** Probe P3 covers, in one run: Windows Terminal and Zellij refusal with a live peer, a teammate invoking the command, an unattached stranger, another team's lead, and a replaced/stale lead instance. Every case rejects (`cannot close teammate panes` / `live lead` / `Only the team lead`) and `ctx.shutdown` is never called; the peer is not marked stopped. This closes the delegation's "a refusal … does not exit the lead" check.
3. **A close error mid-way does not exit the lead.** Probe P4 seeds two running peers and makes `terminal.kill("%peer2")` throw after the first peer was already closed. The handler rejects with `pane kill failed`, `ctx.shutdown` stays at 0 calls, and team data remains. (The already-killed member is marked stopped before the adapter throw — that is pre-existing `killTeammate` ordering, not introduced by this diff.)
4. **The lead pane is not killed.** No diff touches `closeTeammatePanes`/`killTeammate`; `closeTeammatePanes` filters `agentType !== "lead"` and `name !== "team-lead"` (`extensions/index.ts:1807-1808`), and `killTeammate` returns early for `team-lead` (`extensions/index.ts:1846`). `ctx.shutdown()` exits the lead's own Pi process only. Probe P1/P7 confirm no lead-containing kill target was dispatched.
5. **Windows Terminal/Zellij refusal is behaviorally unchanged.** The refusal logic (`requireCloseableTerminal`, `extensions/index.ts:1770-1774`) and both in-loop re-checks are untouched by the diff; all five terminal-related tests (four refusals plus the stopped-team dissolution exception) pass, and probe P3 repeats the refusal with a live peer.
6. **A stale lead cannot close.** `assertLiveLead` (`extensions/index.ts:1752-1766`) is unmodified and compares the saved conversation plus the runtime lease (instance id, session id/file, process liveness, not stopped/detached). The replaced-lead test and probe P3 pass.
7. **`/team-shutdown` keeps its destructive semantics and gains no lead exit.** Probes P5 (command) and P5b (tool) assert `ctx.shutdown` is never called while team/task dirs are deleted. `shutdownTeam` contains no `ctx.shutdown()` call.
8. **Session recovery after the exit still works.** Probe P6 reproduces the real sequence: `/team-close` → `ctx.shutdown()` → `session_shutdown(reason:"quit")` marks the lead `stopped`+`detached`; roster/config are intact; a fresh extension instance on the **same lead conversation** re-claims the lease, spawns the peer pane for the peer's original session file (`spawns.at(-1).command` contains `peerIdentity.file`), and the lead runtime is live again. The full `session-recovery.test.ts` suite also passes.
9. **Detach race is handled.** Probe P8 forces `session_shutdown` to fire while `closeTeammatePanes` is mid-loop; the handler closes the peer, then rejects with `already detaching` and does not call `ctx.shutdown`. No exit after detaching.
10. **Host exit path (source inspection, no Pi CLI run).** Pi 1.1.0 in this repo's `node_modules`: the extension context `shutdown()` calls `_extensionShutdownHandler` (`dist/core/agent-session.js:2761-2766`); interactive mode's handler sets `shutdownRequested` and, when `session.isIdle`, immediately calls its own `shutdown()` (`dist/modes/interactive/interactive-mode.js:1532-1537`); that `shutdown()` stops the TUI, disposes the runtime — which emits `session_shutdown` with `reason: "quit"` (`dist/core/agent-session-runtime.js:296-301`) — prints the resume command, and `process.exit(0)` (`dist/modes/interactive/interactive-mode.js:3477-3512`). Extension commands execute before any agent run starts (`dist/core/agent-session.js:1525-1536`), and `isIdle` is true while no run/compaction is active (`agent-session.js:1053-1055`); if the user runs `/team-close` mid-run, `checkShutdownRequested` fires on `agent_settled` (`interactive-mode.js:2964-2967`). The pane is not closed by any of this.

## Findings

### F1 — Medium: the lead exits even when a teammate was not closed (`lease changed`)

- **Where**: `extensions/index.ts:1465` (`closeTeammatePanes` result), `extensions/index.ts:1840` (line rendered as `peer: lease changed`), `extensions/index.ts:1854` (`killTeammate` returns `lease-changed` when the runtime-instance compare-and-swap loses), `extensions/index.ts:1474` (unconditional `ctx.shutdown()`), and the same unconditional wording in the command description (`extensions/index.ts:1459`).
- **Why it matters**: the delegation check item is "shutdown is requested only after teammate closure succeeds"; `docs/reference.md:355` states "After teammate closure succeeds, the lead Pi is requested to exit back to its shell." On `lease changed` the peer is still running with its pane open — `killTeammate` deliberately does **not** kill it — yet the handler still calls `ctx.shutdown()`. The user is left with a live, orphaned teammate pane and no attached lead, and the final notify is self-contradictory: `"...teammate panes closed (data preserved):\npeer: lease changed\nLead Pi will exit to its shell; the lead pane stays."` No data is lost and a later original-lead resume keeps/restores the live peer, but the command's stated all-panes-closed promise fails.
- **Reproduction (this audit)**: probe **P1** (passes, records actual behavior): mock `replaceRuntimeInstance` → `null`, run the handler; notify contains `peer: lease changed` and `Lead Pi will exit to its shell`, `ctx.shutdown` was called **once**, peer runtime activity is **not** `stopped`, `terminal.kill` was **never** called. Probe **P2** (fails against the contract): same setup, `expect(lead.ctx.shutdown).toHaveBeenCalledTimes(0)` → `expected "vi.fn()" to be called +0 times, but got 1 times`.
- **Frequency/impact**: requires a concurrent runtime-lease replacement during close, so it is a narrow race; impact is an orphaned pane plus a misleading notify, not corruption.
- **Suggested direction (decision for the user/author, not implemented by this audit)**: either skip the exit when any close line is `lease changed` (e.g. test `lines.some(line => line.endsWith("lease changed"))` before `ctx.shutdown()`, keep the lead attached with a warning), or explicitly accept the behavior and reword `docs/reference.md:355`, `README.md:202`, `docs/guide.md:318`, `AGENTS.md:95`, `skills/teams.md:71`, `CHANGELOG.md:29`, and the command description accordingly. Either way, extend the existing `"a lost runtime lease does not kill the pane…"` test (`extensions/team-close.test.ts:150-158`) with the chosen exit expectation.

### F2 — Low: no negative regression coverage that refusals/errors do not exit

- **Where**: `extensions/team-close.test.ts:27,93,105` — the only `ctx.shutdown` assertions are positive (the happy path and the `not running` path).
- **Reasoning**: the invariant "a refusal or close error never exits the lead" is currently protected only by handler ordering, and no test fails if a future refactor moves `ctx.shutdown()` or removes a guard. Probes P3/P4 show the assertions are cheap and all pass on the current tree; `/team-shutdown` also has no `ctx.shutdown`-not-called assertion (probes P5/P5b).
- **Suggested fix**: add `expect(lead.ctx.shutdown).not.toHaveBeenCalled()` to the WT/Zellij, stale-lead, teammate, unattached, and other-team cases, plus the mid-close error case; add the same negative assertion to the `/team-shutdown` tests and the `team_shutdown` tool test.

### F3 — Low (process): two independent features share the uncommitted tree

- The diff mixes the `/team-close` lead-exit change with the unrelated `team_set_model` tool (`extensions/index.ts`, `extensions/team-model.test.ts`, `extensions/quiescence.test.ts` regex loosening, README/reference/CHANGELOG model text). The hunks are cleanly separable, but this project's rule is to land independent changes separately (and F1 is a close-path fix that should not be entangled with model-tool work). Not a behavior defect; noted because the delegation made the same observation.

### F4 — Informational: notify-before-guard race

- If `sessionStopping` flips between `closeTeammatePanes` returning and the `extensions/index.ts:1473` re-check, the user has already been told "Lead Pi will exit to its shell" and then gets `"Lead Pi could not exit because the session is already detaching"`. Probe P8 confirms the important part: no `ctx.shutdown()` is issued and the peer close still happened. Cosmetic only.

### F5 — Informational: the historical close audit now describes pre-change behavior

- `docs/audits/team-close.md` (committed with `623671e`) says, for example, that close "did not stop the lead runtime" and "the existing lead poller remains attached after close". Those statements are true of the tree that audit examined and are now superseded by this working-tree change. Treating audit files as immutable historical records (the project's existing convention) is consistent; this note is only so a reader does not mistake that audit for the current contract.

### F6 — Informational: end-to-end boundary not executed

- No Pi CLI, real pane, or process-exit observation was permitted, so the `process.exit(0)` and shell-return step is proven by Pi 1.1.0 source inspection (item 10 above), not by execution. Everything up to and including the `ctx.shutdown()` call, the `session_shutdown(quit)` state transition, and restoration on a fresh lead is verified by execution in the isolated fixture.

## Conclusion

The lead-exit behavior is correct on the happy path and on every refusal/error/detach path I could construct, the lead pane is not closed, `/team-shutdown` is unaffected, and recovery after the exit works. The one substantive problem is F1: the tree can leave a running teammate while exiting the lead, contrary to the delegation's own acceptance criterion and the reference doc. **Fix F1 (or explicitly accept and document it) and add the F2 negative assertions; then the change is ready.**
