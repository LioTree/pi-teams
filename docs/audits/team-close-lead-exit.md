# /team-close lead exit — independent audit, 2026-10-19 UTC

## Verdict

**Conditionally ready: the requested behavior is implemented and verified, but one Medium conformance gap must be fixed or explicitly accepted before landing.** Findings: **0 High, 1 Medium, 2 Low, 1 informational**.

Re-run evidence (all executed by this auditor, not taken from the author's report): `extensions/team-close.test.ts` **19/19 passed**; full suite **32 files / 432 tests passed**; `tsc --noEmit` exit 0; `git diff --check` clean. Three additional auditor-authored characterization tests in an isolated `/tmp` fixture (no repository mutation) verify the new behaviors directly, including one that exposes the Medium finding.

## Identity, scope, and source fingerprint

- Auditor: `close-exit-auditor`; model **volcengine-codingplan/glm-5.3**, thinking **high** (as delegated; unchanged).
- Branch: `feat/team-quiescence-check`; HEAD `403e0549bbd7e1bb795850ca12b477ac523d01a9`. Audited change: the uncommitted working-tree diff versus HEAD, scoped to the `/team-close` lead-exit behavior (command handler in `extensions/index.ts`, `extensions/team-close.test.ts`, and the doc lines about lead exit in `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/guide.md`, `docs/reference.md`, `skills/teams.md`).
- No implementation, test, or existing doc was edited. No commits, pushes, installs, reloads, real providers, Pi CLI, tmux against live panes, or `~/.pi` mutation. The only authored artifact is this report plus `/tmp/close-audit/` (temporary).
- Intended behavior per delegation: after `/team-close` successfully closes teammate panes, request the lead Pi to exit back to its existing shell; the lead pane stays; roster/tasks/inbox/sessions stay; resuming the original lead session still restores teammates; `/team-shutdown` stays destructive and gains no lead exit.

SHA-256 of audited files (recorded before report authoring; re-verified identical after):

| File | SHA-256 |
| --- | --- |
| `extensions/index.ts` | `d7f810ab0e2ae71e292dfb78c7ced5d7ab132902fe8268982bbc73704bbcbe30` |
| `extensions/team-close.test.ts` | `cb0b077df7555eb5246ff877a8d0239cb904662ecac95a59c04f5b6abab88909` |
| `extensions/quiescence.test.ts` | `139e9ba6dbf3393d292c0b0db919dd56f90dc10db9de721349d299edbf20462d` |
| `extensions/team-model.test.ts` | `3e97efba851885c8143d9bb4fcca503674b2d12c8fd6045858a12c7c65fe0b22` |

## What the change is

`extensions/index.ts:1458-1475` — the `/team-close` handler keeps its previous guards (`sessionStopping` check, `assertLiveLead` at `extensions/index.ts:1752`, then `closeTeammatePanes` at `extensions/index.ts:1806`), then notifies the user and calls `ctx.shutdown()` (`extensions/index.ts:1474`). `ctx.shutdown()` is Pi's documented "Gracefully shutdown pi and exit" API (`@earendil-works/pi-coding-agent` `types.d.ts`, "Available in all contexts"). `shutdownTeam` (`extensions/index.ts:2609`, shared by `/team-shutdown` and the `team_shutdown` tool) does **not** call `ctx.shutdown()` — the destructive path gains no lead exit.

## Verified behaviors

1. **Exit requested only after teammate closure completes without throwing.** `assertLiveLead` throws first (stale lead, teammate, unattached session, other team's lead — all covered by existing tests and re-run here). `closeTeammatePanes` throws on WT/Zellij refusal (`requireCloseableTerminal`) and on any `terminal.kill`/`killWindow` error (no try/catch in `killTeammate`, so errors propagate). In all those cases the handler rejects before `ctx.shutdown()`. Auditor probe B (isolated fixture): stale lead → `ctx.shutdown` call count **0**; Windows Terminal refusal with a live lead → count **0**, peer activity not `stopped`.
2. **The lead pane is not killed.** `closeTeammatePanes` filters out lead members; `killTeammate` short-circuits `team-lead`. `ctx.shutdown()` exits the lead's own Pi process; the terminal pane remains with its shell. Test asserts `adapter.kill` is never called with a lead-containing target.
3. **Windows Terminal/Zellij refusal is unchanged** — the `requireCloseableTerminal` preflight and in-loop re-checks are untouched by this diff; all four WT/Zellij refusal tests pass unchanged.
4. **A stale lead cannot close.** `assertLiveLead` compares the saved lead session identity plus the runtime lease (instance id, session id/file, process aliveness, not stopped/detached). The "replaced lead instance" test passes.
5. **Session recovery still works after the exit.** Auditor probe C (isolated fixture): `/team-close` → `ctx.shutdown()` → `session_shutdown(reason: "quit")` marks the lead `stopped`+`detached`; a fresh process resuming the same lead conversation re-claims the lease (`claimSession`'s live-owner guard requires `!previous.detached`, `src/utils/team-session.ts:160-171`), clears `detached`, and `restoreTeamPanes` relaunches the teammate pane for its original session ("restored — pane launched for original session; registration pending, no task replay"), with the roster intact at 2 members. Existing `session-recovery.test.ts` also covers resume-after-dead-PID.
6. **Docs match code** for the happy path: AGENTS.md, README.md, guide.md, reference.md, skills/teams.md, and the CHANGELOG bullet all describe "close teammate panes, then exit the lead Pi back to its shell; the lead pane and team data stay". The command description and notify text match. `/team-shutdown` docs still describe dissolution only, matching its code.
7. **Tests re-run**: `extensions/team-close.test.ts` 19/19 (matches the author's claim), full suite 32 files / 432 tests, `tsc --noEmit` clean, `git diff --check` clean.

## Findings

### F1 — Medium: lead exit is also requested when a teammate was *not* closed (`lease changed`)

- **Where**: `extensions/index.ts:1465-1474`. `closeTeammatePanes` returns normally (does not throw) when `killTeammate` reports `lease changed` (the peer's runtime lease was concurrently replaced, so its pane was neither killed nor marked stopped). The handler then unconditionally calls `ctx.shutdown()`.
- **Why it matters**: the delegation's own check item is "shutdown is requested only after teammate closure succeeds", and `docs/reference.md` states "After teammate closure succeeds, the lead Pi is requested to exit back to its shell." A `lease changed` member is still running with its pane open while the lead Pi exits — the user is left with an orphaned teammate pane and no attached lead. The final notify text is internally contradictory in this case: `"...teammate panes closed (data preserved):\npeer: lease changed\nLead Pi will exit to its shell; the lead pane stays."`
- **Reproduction** (auditor probe A, isolated `/tmp` fixture mirroring the existing "a lost runtime lease" test with `replaceRuntimeInstance` mocked to `null`): handler completes, notify contains `peer: lease changed` **and** `Lead Pi will exit to its shell`, `ctx.shutdown()` call count **1**, peer runtime activity stays **`idle`** (not stopped, pane not killed).
- **Impact bounds**: reported in the notify (not silent), no data loss, and resuming the lead later retains/restores the live peer correctly. Frequency is low (requires a concurrent lease change during close).
- **Suggested fix**: skip the exit (or keep the lead alive with a warning) when any close line reports `lease changed`, e.g. `const incomplete = lines.some(l => l.endsWith("lease changed"))` before `ctx.shutdown()`; align the docs and add an assertion to the existing "a lost runtime lease" test (it currently asserts nothing about shutdown either way). Alternatively, explicitly accept and document the behavior — but then `docs/reference.md` and the delegation contract should say so.

### F2 — Low: no negative coverage that refusals do not exit the lead

- **Where**: `extensions/team-close.test.ts` — the new `ctx.shutdown` assertions are only positive ("closed" and "not running" cases). None of the refusal tests (WT/Zellij, stale/replaced lead, teammate, unattached session, unattached other-team lead) assert `ctx.shutdown` was *not* called.
- **Reasoning**: the handler structure makes it obvious today (every refusal throws before line 1474), but the intended invariant "a refusal or close error never exits the lead" is untested; a future refactor could reorder guards silently. Auditor probe B demonstrated the assertions are cheap to add (all pass).

### F3 — Low (process observation): the uncommitted working tree mixes two features

- The same uncommitted diff contains the unrelated `team_set_model` leader tool (`extensions/index.ts` `submitTeammateModelChange`/`team_set_model` registration, `extensions/team-model.test.ts` +2 tests, the `quiescence.test.ts` regex loosening, and README/reference/CHANGELOG model-tool text). It is cleanly separable from the team-close change (disjoint hunks), but landing both as one commit contradicts this project's rule of keeping independent changes on separate commits/branches. Recommend committing the two features separately (or confirming the model-tool work was already audited under its own task).

### F4 — Informational: notify-then-error inconsistency in a narrow race

- If `sessionStopping` flips between `closeTeammatePanes` returning and the `extensions/index.ts:1473` re-check, the user has already been told "Lead Pi will exit to its shell" and then receives "Lead Pi could not exit because the session is already detaching". Cosmetically inconsistent but harmless (teammates are already closed and the session is exiting anyway).

## Method notes

- Tests were run with the repository's own vitest 4.0.18 against Pi 1.1.0 (`@earendil-works/pi-coding-agent` types confirm `ctx.shutdown(): void`, "Gracefully shutdown pi and exit", plus the command-context `shutdown` binding).
- The auditor probes live at `/tmp/close-audit/` (a sed-rewritten copy of `team-close.test.ts` with absolute imports plus three added cases; a `node_modules` symlink was used and removed afterwards; all 22 cases pass there). No repository file was modified; SHA-256 manifests above were re-verified identical after all test runs.
