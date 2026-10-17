# Team reload (`/team-reload`) — independent audit, 2026-10-17

## Verdict

**Not ready to commit as-is.** One blocking defect (R1) and two should-fix defects (R2, R3) were found; all three share one root cause: a reloading member publishes `activity: "stopped", detached: true` in `session_shutdown`, which every other member interprets as "process gone" for the whole reload window. `/team-reload` turns that pre-existing property of a manual `/reload` into a near-certain team-wide race because it makes the lead and every idle teammate reload within the same second.

The due/receipt logic, loop prevention, safety gate, and the Pi 1.1.0 dispatch path (`sendUserMessage` → `prompt` → `_tryExecuteExtensionCommand` → `ctx.reload()`) were checked and found correct. Test suite: 29 files / 370 tests pass; `npx tsc --noEmit` is clean.

## Identity and scope

- Auditor: `reload-auditor` (independent, not the author), model `cursor/claude-fable-5-1`, thinking `medium`.
- Repo: `/home/liontree/pi-teams`, branch `feat/team-quiescence-check`, HEAD `38e0f6f` (committed, out of scope except for interactions).
- Audited: the uncommitted diff (`AGENTS.md`, `CHANGELOG.md`, `README.md`, `docs/guide.md`, `docs/reference.md`, `extensions/index.ts` +90, `skills/teams.md`) and untracked `src/utils/team-reload.ts` (md5 `8935235350…`), `extensions/team-reload.test.ts` (md5 `7d95d88f77…`).
- Pi sources read: `dist/core/agent-session.js` (`prompt`, `_tryExecuteExtensionCommand`, `sendUserMessage`, `reload`, `isIdle`/`isStreaming`), `dist/modes/interactive/interactive-mode.js` (`handleReloadCommand`), `dist/modes/rpc/rpc-mode.js` (reload binding), `dist/core/extensions/runner.js` (`reload` ctx binding, `invalidate`, `emitSessionShutdownEvent`), `dist/core/extensions/loader.js` + `dist/core/resource-loader.js` (jiti `moduleCache: false`, `clearExtensionCache()` on reload).
- Commands run: `npx tsc --noEmit` (exit 0), `node node_modules/vitest/vitest.mjs run` (370 passed). Reproductions were run only in a copy at `/tmp/pi-teams-audit` (repo files untouched; the repro test file lives only in `/tmp`).
- Line numbers below refer to the working tree at audit time.

## Verified defects

### R1 — P1 (blocking): lead self-reload launches a duplicate pane for a teammate that is mid-reload

**Evidence.**
- `extensions/index.ts:1541-1567` — `session_shutdown` ignores `event.reason` and always publishes `activity: "stopped", detached: true`.
- `extensions/index.ts:1646-1649` — `isMemberAlive` returns `false` for any member with a session mapping whose runtime record has `detached: true`, regardless of PID liveness.
- `extensions/index.ts:1264-1267` — the lead runs `restoreTeamPanes` on every `session_start`, including `reason: "reload"`.
- `src/utils/team-session.ts:217-223` — `restoreTeamPanes` retains a member only if `alive(status) && !status.detached`; a detached record falls through to the launch path, and `member.recovery.phase === "attached"` (set by the original launch) does not block it (`:229-240`).
- `extensions/index.ts:1033-1041` and `:1314-1331` — `/team-reload` resets `reloadDispatchedAt` so the lead's own poll dispatches its reload within ≤1 s of the request; every idle teammate's poll does the same. Both sides then spend their reload window (jiti recompiles every extension with `moduleCache: false`; `resource-loader.js:352-356`) in overlapping intervals.

**Reproduction** (`/tmp/pi-teams-audit/extensions/audit-repro.test.ts`, test R1, passes = defect present): peer attached, lead attached, no spawns. Peer emits `session_shutdown{reason:"reload"}` → its runtime record is `stopped/detached`. Lead reloads (`session_shutdown` + `session_start{reason:"reload"}`). Result: `terminal.spawn` is called for `peer` with a fresh recovery token and the lead is notified `peer: restored — pane launched for original session`. The original peer process then completes its own reload and successfully re-claims the member (`idle`, `detached:false`, same PID). The recovery child that was spawned with `--session <peer session file>` will fail `claimSession` ("another live process owns this member") but it is already a second Pi process opened on the same session JSONL in a stray tmux pane; the roster's `tmuxPaneId` and `recovery` are also overwritten by the launch.

**Why it is blocking.** The feature's design guarantee is that reload is not dispatch and touches no roster; here it mutates the roster, spawns a process, and produces two Pi instances on one session file. The overlap is not a corner case: with one lead and N idle teammates all dispatched within the same second, the lead's `restoreTeamPanes` runs exactly when teammates are between `session_shutdown` and `session_start`.

**Suggested fix (root cause, covers R2/R3 as well).**
1. Make the handler read `event.reason`. For `reason === "reload"`, do **not** publish `stopped`/`detached`. Publish a same-process marker instead (e.g. `reloading: true`, keep `activity` as `idle`/`interrupted`, keep `pid`/`processStartToken`, refresh heartbeat).
2. In `claimSession`, allow a same-process re-claim: `previous.pid === input.pid && previous.processStartToken === input.processStartToken` (and `previous.sessionId/sessionFile` matching) must pass the "another live process owns this member" check even though `!previous.detached`.
3. Clear `reloading` in `claimSession`. Optionally treat `reloading && !isRuntimeProcessAlive` as dead so a crash during reload still recovers.
4. Independent belt-and-braces: skip `restoreTeamPanes` for `session_start{reason:"reload"}` in the lead (a same-process reload cannot have lost a member that was alive before; `/team-resume <team>` remains the explicit retry), or defer the lead's own self-reload until every other live member holds a receipt for the request.

### R2 — P2: reloading an interrupted (or any) member admits a spurious quiescence inspection with a false "dead/stopped" fault

**Evidence.**
- `extensions/index.ts:1565-1566` — `session_shutdown` calls `admitQuiescenceInspection` after publishing `stopped/detached`, for every reload.
- `src/utils/quiescence.ts:168-175` — `quiescenceGate` treats dead/stopped members as *faults, not blockers*, and only non-idle *live* members block; an `interrupted` member blocks only while it is alive.
- `extensions/index.ts:1006-1019` — `reloadIsSafe` deliberately allows interrupted sessions to reload.

**Reproduction** (`audit-repro.test.ts`, test R2, passes = defect present): open one formal generation; peer becomes `interrupted`; lead idle; after >1 s of polling no inspection exists (gate reason `peer is interrupted`). Peer emits `session_shutdown{reason:"reload"}` → the lead's inbox receives a `[pi-teams quiescence inspection]` for generation 1 listing `peer (teammate): dead stopped` and fault `peer is dead; unfinished work is a blocker, not a success`. The peer then comes back `interrupted`. The lead is told the team is quiescent and that the peer is dead; both statements are false, and the generation is then consumed by the lead's settlement (#348), so the real quiescence moment later produces no inspection.

For an idle member the inspection would already have been admitted earlier, so the only effect is a misleading `X is stopped` fault line if the admission happens to land in the window; the interrupted case is the material one. Fix: R1 root-cause fix (no `stopped/detached` on reload), or at minimum skip the `admitQuiescenceInspection` call in `session_shutdown` when `event.reason === "reload"`.

### R3 — P2: a lead `team_wait` held open by a live interrupted peer can return `no_active_agents` while that peer reloads

**Evidence.**
- `src/utils/team-wait.ts:24-29, 61-63, 190-200` — `interruptedPeerHoldsWait` requires `alive`; a dead peer is `progressCapable:false` and does not hold the wait; two consecutive inactive polls (`TEAM_WAIT_INACTIVE_POLLS = 2`, 1 s apart) return `no_active_agents`.
- `extensions/index.ts:1646-1649, 1678-1690` — the wait's `getPeers` uses `isMemberAlive`, which is `false` while the peer's record is `detached: true`.
- The lead can be in `team_wait` while `/team-reload` runs: Pi executes extension commands immediately even during streaming (`agent-session.js:1523-1532`), and the lead's own reload is deferred by `agentLoopActive`, but teammates are not deferred by the lead's wait.

**Reasoning / window.** Interrupted peer reloads → `stopped/detached` for the duration of its reload (full extension recompile; typically on the order of a second or more) → if two lead polls fall in that window the wait returns `no_active_agents`, violating the invariant that a live interrupted peer keeps an indefinite wait open until it resumes, stops, or dies (#275). Not reproduced with real timing (Pi CLI is out of scope); the code path is deterministic given a window ≥2 polls. Fix: R1 root-cause fix. A narrower alternative is to make `reloadIsSafe` for an interrupted session also require that no live peer is currently `waiting`, but that couples members unnecessarily.

## Minor findings

### R4 — P3: `reloadDue` receipt/PID clause is unreachable and does not protect against what it implies

`src/utils/team-reload.ts:60-63`: the receipt+PID check only matters when `loadedAt <= request.requestedAt`, but a receipt is only ever written when `EXTENSION_LOADED_AT > request.requestedAt` (`extensions/index.ts:1026-1029`). For the same process these cannot both hold, so the clause is dead; loop prevention rests solely on `EXTENSION_LOADED_AT` advancing. That works because Pi clears its extension cache on reload (`resource-loader.js:352-356`, `loader.js:89-93, 461-466`) and jiti runs with `moduleCache: false`. Documented in `docs/reference.md:339` as if the PID receipt were part of due-ness. Suggest removing the clause (and the `pid` parameter) or replacing the clock comparison with the request id observed at module load (see R5), which would make the receipt the real guard.

### R5 — P3: due-ness depends on wall-clock ordering between the lead's `Date.now()` and each member's `EXTENSION_LOADED_AT`

Same host, so skew is limited to clock steps. A backward step between a member's load and the request makes `loadedAt > requestedAt` true → the member silently records a receipt and `status` reports `reloaded` without reloading. A forward step or a same-millisecond tie merely costs one extra reload. Suggest: at module load, read `reload/request.json` once and store its `id` as `REQUEST_SEEN_AT_LOAD`; a request is due iff `request.id !== REQUEST_SEEN_AT_LOAD` and no receipt from this PID exists. No clocks, and the receipt clause becomes live.

### R6 — P3: silent receipt-write failure leaves `status` at `pending` forever with no diagnostic

`extensions/index.ts:1028` swallows `recordReloaded` errors. The member will not loop (`reloadDue` is already false) but `/team-reload status` shows `pending (idle)` indefinitely and nothing says why. Suggest surfacing via `ctx.ui.notify`/`lastError` or writing a `deferred`/`error` field the status command can print.

### R7 — P3: `status` cannot distinguish "waiting for a safe moment" from "stuck"

A member with permanently unknown inbox acceptance (`pendingInboxDelivery` never confirmed, `ackLeaseLost`) or a long `pendingInspectionRelease` will never satisfy `reloadIsSafe` and shows only `pending (idle)` or `pending (interrupted)`. Suggest the poller record the blocking reason (e.g. into the receipt file or runtime status) so `status` can print `pending (idle; deferred: unknown inbox acceptance)`.

### R8 — P3: automatic reload can interrupt a human typing in a teammate pane

`handleReloadCommand` (`interactive-mode.js:5357-5432`) swaps the editor for a "Reloading…" box and `resetExtensionUI()` closes extension overlays. `isIdle()` is true while a human composes a prompt or has `/model` open, so an unattended reload can land mid-interaction. Pi restores the same editor instance, so draft text survives in the success path, but overlays are dismissed. Accepted limitation unless Pi exposes editor state; worth a sentence in the docs.

### R9 — P3: `/team-reload-self` is visible in slash-command autocomplete

Registered with a user-facing description (`extensions/index.ts:1337`). A human typing it with a bogus id is harmless (id check + safety gate), but it is noise. Pi has no hidden-command flag; consider a name that sorts last or a description that says "do not run manually".

## Claims checked and found correct

- **Dispatch path and deadlock.** `pi.sendUserMessage(text, {expandPromptTemplates:true})` → `AgentSession.sendUserMessage` → `prompt()` → `_tryExecuteExtensionCommand` runs the handler synchronously (no run started, nothing appended to history, `preflightResult("handled")`), the handler's re-checks (`dueReloadRequest`, id match, `reloadIsSafe`) run in the same tick as the dispatch, then `ctx.reload()` → runner `reloadHandler` → interactive `handleReloadCommand` → `session.reload()` → `emitSessionShutdownEvent(oldRunner)` → our `session_shutdown` → `oldRunner.invalidate()` → new runner → `session_start{reason:"reload"}`. No lock is held by the command or by `prompt()`; the only awaits inside are our own file locks. Calling `ctx.reload()` from a command is the documented pattern (runner invalidate message). After `await ctx.reload()` the old closure reads only its own `sessionStopping` flag; it never touches the stale `ctx`. `prompt()`'s `_isEmittingAgentSettled` deferral cannot cause a loop: `reloadIsSafe` already requires `!settlementActive`. If the extension errors, Pi reports it via `emitError`; the `.catch` on the runtime's `sendUserMessage` cannot be reached for a handled command.
- **Host refusal.** `handleReloadCommand` refuses only on `isStreaming` (`_isAgentRunActive`) or `isCompacting`; `ctx.isIdle()` is `!_isAgentRunActive && !isCompacting`, so our gate already excludes both and the 10 s retry (`RELOAD_DISPATCH_TIMEOUT_MS`) only matters for a race. RPC mode binds `reload` to `session.reload()` directly without those checks; our gate still applies. Print mode has no binding (`reloadHandler` no-op) → harmless 10 s retries, no UI.
- **Loop prevention.** `EXTENSION_LOADED_AT` is re-evaluated on every reload because Pi calls `clearExtensionCache()` and jiti has `moduleCache: false`. A request older than the loaded code is never due; the newly loaded poller writes the receipt once (`!isReloadedFor` guard) and stops.
- **Repeated / superseded requests.** A second `/team-reload` writes a new id. A member whose new module evaluated after the second request records a receipt for it (the code on disk at load time is at least as new); one that finished before it reloads again. A stale `/team-reload-self <old-id>` is rejected by the id check (tested).
- **PID reuse.** A stale receipt from a dead process can only affect `isReloadedFor` (status display); any new process has `loadedAt > requestedAt` and writes its own receipt. No incorrect reload decision results.
- **Concurrent pollers.** Overlapping `pollTeamCoordination` ticks cannot double-dispatch: `reloadDispatchedAt` is set synchronously before `sendUserMessage`, and `reloadingForRequest` guards the handler. A stale in-flight poll resuming after shutdown is stopped by `sessionStopping` in `dispatchRequestedReload`.
- **In-memory obligations.** `reloadIsSafe` covers every closure-held duty: `pendingInboxDelivery` (unknown and confirmed-but-unacked), `inboxDeliveryInFlight`, `acceptedInspection`, `inspectionAckPending`, `pendingInspectionRelease`, `pendingInterrupt`, `pendingResume`, `settlementActive`, `agentLoopActive`, `sessionStopping`. `runtimeInstanceId` changes across reload and `claimSession` rewrites the lease; a *pending* (not accepted) inspection is plain inbox mail and survives. `incomingLeadHandoffToken`/`incomingRecoveryToken` are consumed on first start and the reloaded closure attaches via the saved session mapping. Pause: `wasPaused` → `paused:true` → `claimSession` restores `interrupted` (tested; `team-reload.test.ts:89-101`).
- **Not dispatch.** No `openFormalGeneration`, no task/inbox/roster write on the reload path itself (R1 is an indirect roster mutation through recovery). The reload-self command never reaches the model.
- **Lead-only, status without request.** `isTeammate` check and `args.trim() !== "status"` branch behave as documented (tested).
- **`team_shutdown` cleanup.** `fs.rmSync(teamDir, {recursive:true})` (`extensions/index.ts:335`) removes `reload/`.
- **`atomicWriteJsonSync`** creates the `reload/` directory (`atomic-file.ts:10-11`).

## Test quality

The six tests are real end-to-end tests through the extension wrapper and do guard: once-only dispatch and id mismatch (1), busy deferral then dispatch (2), interrupted reload with pause persistence (3), unknown-acceptance deferral (4), receipt + `status reloaded` for already-current code (5), lead-only (6). `vi.restoreAllMocks`/temp dirs are cleaned.

Gaps:
- No test runs two members through overlapping reloads (would have caught R1), and the terminal adapter is mocked to `null`, so `restoreTeamPanes` always throws "requires tmux" and is never exercised on the reload path.
- No test asserts the quiescence state/lead inbox is unchanged by a reload (would have caught R2), and none covers `team_wait` across a peer's reload (R3).
- `EXTENSION_LOADED_AT` is a module constant in the test process, so the real "new code writes the receipt after a real request" transition is never observed; test 5 simulates it with `requestedAt: 0`.
- `reloadIsSafe` branches for `acceptedInspection`, `inspectionAckPending`, `pendingInspectionRelease`, `pendingInterrupt`, `pendingResume`, and `inboxDeliveryInFlight` are untested.
- Host refusal (`ctx.reload` resolving with the session still active) and the 10 s retry are untested.
- Superseded request (second `/team-reload` mid-flight) and `status` for a not-running member are untested.
- Test 3 does not assert that the reloaded interrupted peer still refuses inbox delivery.

## Docs versus code

Accurate: README, `docs/guide.md`, `AGENTS.md`, `skills/teams.md`, CHANGELOG entry, and most of `docs/reference.md` (request/receipt files, 1 s poller, safety list, `/team-reload-self`, 10 s retry, pause persistence, lead-only error, manual reload for old versions).

Inaccurate or incomplete:
- `docs/reference.md:339` describes the "no receipt for this request ID from its current PID" clause as part of due-ness; it is unreachable (R4).
- `docs/reference.md:341` "Reload does not … change tasks, inbox, or roster": `claimSession` on every reload rewrites `member.session`, `cwd`, `tmuxPaneId`, `recovery.phase`, `leadSessionId` (pre-existing), and R1 can spawn a recovery launch that rewrites `tmuxPaneId`/`recovery`.
- None of the docs mention that every reloading member is visible to the rest of the team as `stopped`/dead for the duration of its reload (R1–R3), nor that the lead reloads itself in the same second as the teammates, nor the editor/overlay effect in panes (R8).
- `docs/reference.md:339` "if the host refuses (for example while streaming or compacting)": both are already excluded by the extension's own `isIdle()` gate; refusal is a race, not the normal case.

## Speculative concerns (not verified)

- Reload duration in a real Pi process was not measured (Pi CLI out of scope). R3's probability depends on it; R1 and R2 do not.
- Other extensions (e.g. magic-context) also receive `session_shutdown{reason:"reload"}`/`session_start` from an unattended reload; their behavior was not reviewed.
- The lead `/team-reload` output and the Pi "Reloaded …" status appear in every pane; whether a user running `/team-reload` from a non-tmux adapter sees anything confusing was not checked.

## Limits

Read-only audit; no commits, installs, Pi CLI, tmux, network, or live `~/.pi` mutation. Reproductions live only in `/tmp/pi-teams-audit` and are not part of the repository.

---

# Re-audit of the R1–R4 fix, 2026-10-17 (task 30)

The sections above are the original task-29 report and are retained unchanged as history. Line numbers in this section refer to the working tree at re-audit time.

## Verdict

**Still not ready to commit.** R1, R2, R3, and R4 are closed as specified, and the author's claims about the new tests hold. The fix introduces one new blocking regression (N1): the same-process re-claim requires a defined process start token, which only exists on Linux (`/proc/<pid>/stat`), so on macOS/Windows **every** reload (manual `/reload` or `/team-reload`) now detaches the member from its team and strands it as `reloading: true`. Two further minor findings (N2, N3) concern the stranded marker and downgrades. Accepted P3s from the first audit (R5, R6, R8, R9) are unchanged.

## Identity and scope

- Same auditor and model as task 29 (`reload-auditor`, `cursor/claude-fable-5-1`, thinking `medium`).
- Repo `/home/liontree/pi-teams`, branch `feat/team-quiescence-check`, HEAD `38e0f6f`. Audited working-tree fingerprints: `extensions/index.ts` md5 `8d3bfb9a11…`, `src/utils/team-session.ts` `a98d23cec0…`, `src/utils/team-reload.ts` `82f8ca646b…`, `extensions/team-reload.test.ts` `0a3cb3cde3…`; plus `src/utils/runtime.ts`, `docs/reference.md`, `docs/guide.md`, `CHANGELOG.md` diffs.
- Commands run in the repo (read-only): `npx tsc --noEmit` (exit 0), `node node_modules/vitest/vitest.mjs run` (29 files / 374 tests passed).
- Reproductions and the one mutation experiment were run only in a fresh copy at `/tmp/pi-teams-audit` (`extensions/audit-repro2.test.ts`; repo untouched, verified by md5 after restoring the copy).

## Disposition of task-29 findings

| ID | Status | Evidence |
|----|--------|----------|
| R1 P1 duplicate pane | **Closed** | `extensions/index.ts:1560-1569` publishes only `reloading: true` (+`paused`) on `reason === "reload"`; `:1266-1269` skips `restoreTeamPanes` on a reload start; `src/utils/team-session.ts:222-227` retains a live, non-detached member. Repro `R1 re-check`: peer and lead both mid-reload, lead `session_start{reload}` spawns nothing; an explicit `restoreTeamPanes` reports `peer: alive`; the peer then re-claims (`idle`, same PID). (My assertion on `tmuxPaneId` failed only because the test process itself runs inside tmux and `claimSession` writes `process.env.TMUX_PANE`; that is pre-existing claim behavior, not a reload defect.) |
| R2 P2 false quiescence fault | **Closed** | `admitQuiescenceInspection` is not reached on a reload shutdown (`:1568 return`). Repro `R2 re-check`: interrupted peer reloads with an open generation; no inspection after >1 s; after re-claim the peer is `interrupted/paused`; when it later resumes and finishes, exactly one inspection arrives and it does not say `dead`. New test 8 (`team-reload.test.ts:155-166`) guards this. |
| R3 P2 early `no_active_agents` | **Closed by construction** | The record keeps `activity: "interrupted"`, `pid`, `processStartToken`, `detached` falsy, so `isMemberAlive` (`:1660-1663`) and `interruptedPeerHoldsWait` see an alive interrupted peer. Repro `R3 re-check`: `team_status` during the peer's reload window reports it `interrupted`, `isRuntimeProcessAlive` true, `detached` falsy. Not timed against a real Pi process (out of scope); there is no longer a window in which the record reads as dead. No direct `team_wait`-across-reload test exists (see Test quality). |
| R4 P3 dead receipt clause | **Closed** | `src/utils/team-reload.ts:60-62` `reloadDue(request, loadedAt)` has no receipt/PID parameter; `docs/reference.md:339` no longer describes it. |
| R5, R6, R8, R9 | Accepted, unchanged | — |
| R7 | Partially addressed | `status` now prints `pending (reloading)` (`extensions/index.ts:1335`); other deferral reasons are still invisible. |

Author's claim "all 4 new tests fail with fixes 1+3 reverted": **verified** in the `/tmp` copy by disabling the `if (reloading)` branch and the `event.reason !== "reload"` guard: tests 6, 7, 8, 9 fail; tests 1–5, 10 pass. Original file restored afterwards (md5 matches the repo).

## New verified defects

### N1 — P1 (blocking): without a process start token (macOS, Windows, any host where `/proc/<pid>/stat` is unreadable) every reload detaches the member

**Evidence.**
- `src/utils/runtime.ts:277-288` — `getProcessStartToken` returns `undefined` unless `process.platform === "linux"` and `/proc/<pid>/stat` is readable.
- `src/utils/team-session.ts:163-166` — `ownReload` requires `previous.processStartToken !== undefined && previous.processStartToken === input.processStartToken`.
- `src/utils/team-session.ts:167-168` — with `ownReload` false, `previous && !previous.detached && alive(previous)` is true for the member's own still-live PID (`isRuntimeProcessAlive` returns true for a live PID with no token, `runtime.ts:290-294`), so `claimSession` throws `another live process owns this member`.
- `extensions/index.ts:1560-1569` — before the fix the reload shutdown published `detached: true`, which made this check pass; the fix removed that escape without replacing it for tokenless hosts.
- The legacy path is inconsistent with the new one: `ownedLegacy` (`team-session.ts:142-144`) accepts `undefined === undefined` tokens.

**Reproduction** (`audit-repro2.test.ts`, `N1`, passes = defect present): `vi.spyOn(runtime, "getProcessStartToken").mockReturnValue(undefined)` (simulating macOS); peer attaches at startup (`idle`, PID set); `session_shutdown{reload}` → record `reloading: true`; new instance `session_start{reload}` → UI notice `Team recovery blocked: another live process owns this member; no takeover or duplicate launch`; runtime stays `reloading: true` with the retired instance's `instanceId`; a message appended to the peer's inbox is never delivered (no poller attached). Control `N1b` with the real Linux token re-claims cleanly.

**Impact.** On the project's supported non-Linux adapters (iTerm2/AppleScript, WezTerm, Windows), any `/reload`, manual or team-wide, permanently detaches the session from its team: no inbox delivery, no activity publication, no `team_wait` participation, while peers keep seeing it as live `idle`/`interrupted` (so recovery never launches either). The only exit is quitting the process. Previously a manual `/reload` worked on these hosts. This is a regression against committed behaviour, not just a limitation of the new feature; the new test 9 covers `"different-start"` but not `undefined`.

**Suggested fix.** Treat a missing token as "same host cannot distinguish" and fall back to the marker our own shutdown wrote: `ownReload = sameProcessReload && previous.pid === pid && sessionId/sessionFile match && (previous.processStartToken === input.processStartToken /* both undefined allowed */ || previous.reloading === true)`. Optionally require `previous.reloading === true` for the tokenless case only. Add a test with `getProcessStartToken` mocked to `undefined` through the extension path, and a `claimSession` negative with a different `identity` at the same PID. Document that same-process identity on non-Linux rests on PID + conversation + the `reloading` marker.

## New minor findings

### N2 — P3: a stranded `reloading` marker is indistinguishable from a healthy member everywhere except `/team-reload status`

If the new code fails to load (syntax error, `_resourceLoader.reload()` or `settingsManager.reload()` throwing after `emitSessionShutdownEvent` — `agent-session.js:2936-2949`), Pi shows `Reload failed` (`interactive-mode.js:5426-5431`) and the process stays alive with no pi-teams instance. The runtime record then stays `reloading: true`, `activity: idle|interrupted`, `detached` falsy, PID alive, heartbeat frozen. Repro `N2`: `/team-reload` prints `peer: pending (reloading)`; `restoreTeamPanes` reports `peer: alive`; `team_status`/quiescence snapshots show a normal live member. An interrupted stranded member holds a lead's indefinite `team_wait` open forever; an idle one is counted as quiescent. This is strictly better than the pre-fix state (where a live-but-extensionless process read as dead and could receive a duplicate recovery launch) and is manually recoverable: fixing the code and running `/reload` in that pane re-claims via `ownReload` (Linux). Suggest: record `reloadingSince`, surface `reloading` (and its age) in `team_status`, the quiescence member list, and `/team-reload status`, and mention the manual recovery in `docs/guide.md`. A process crash mid-reload is handled correctly: PID dead → `isMemberAlive` false → restoration launches, and `claimSession` passes because `alive(previous)` is false.

### N3 — P3: downgrading to a pi-teams version without `sameProcessReload` strands the member the same way as N1

New running code writes `reloading: true` (not `detached`) on shutdown; an older on-disk `extensions/index.ts` claims without `sameProcessReload` and hits `another live process owns this member`. Upgrade (old shutdown → new start) works because the old code publishes `detached`. Not reproducible without the old source; the logic is the same as N1. Suggest a sentence in `docs/reference.md`/CHANGELOG: downgrading below this version requires quitting the pane, not `/reload`.

## Claims checked and found correct

- **`reason === "reload"` is exclusive to Pi's reload.** `agent-session.js:2939,2966` are the only emitters; `/new`, `/resume`, `/fork` use `"new"`/`"resume"`/`"fork"` (`agent-session-runtime.js:141-299`, `types.d.ts:565,626`). The in-module wrapper (`extensions/index.ts:420-435`) forwards the *start* reason to the retired shutdown, so a same-PID `/new`/`/resume`/`/fork` still publishes `stopped/detached` and the next identity must pass `sameSession`. A reload always creates a fresh module (`clearExtensionCache`, jiti `moduleCache: false`), so the wrapper's `started` branch is never taken for a reload.
- **`sameProcessReload` cannot be used for takeover.** The caller still has to pass `sameSession(member.session, identity)` (`team-session.ts:158-160`); `ownReload` additionally requires equal PID, defined and equal start token, and equal `sessionId`/`sessionFile`. A different conversation in the same PID, a copied session file in another PID, or a recovery child are all rejected. Test 9 covers wrong PID, wrong token, and missing flag; it does not cover a different identity (would be rejected by `sameSession` first). Pre-existing `legacyReload`, handoff, and `manualAssociation` paths are unchanged; `incomingRecoveryToken`/`incomingLeadHandoffToken` are consumed on first start and are `undefined` on a reload start, so the reservation check (`:134-136`) is skipped as before.
- **Interrupted pause across reload.** Shutdown writes `paused: true`; claim computes `paused` from `previous.paused || activity === "interrupted"` and restores `interrupted` (test 3, test 8, repro R2).
- **Inbox single-flight.** `reloadIsSafe` still refuses while `pendingInboxDelivery`/`inboxDeliveryInFlight`; `inboxAwaitingConfirmation` is on file and re-hydrated by `attachSession` (`:1249-1257`). A message arriving mid-reload is appended and `markRuntimeQueuedIfIdle` may set `queued`; the re-claim resets to `idle` and the new poller delivers it. Nothing is acknowledged or resent.
- **Quiescence.** The lead's own poller still admits an inspection for an *idle* member mid-reload, exactly as it would for the same idle member before reloading — no new admission is caused by the reload itself; interrupted members block it throughout (repro R2).
- **Lead self-reload.** `restoreTeamPanes` skipped on `reason === "reload"` (test 7); `/team-resume <team>` remains the explicit retry; a reloading lead no longer trips `lead authority lost` for peers' in-flight checks because it is neither `detached` nor `stopped` (`team-session.ts:218`).
- **Stale-runtime cleanup** (`runtime.ts:396-405`) keys on PID liveness, unaffected by `reloading`.
- **Status output.** `pending (reloading)` is printed from the file marker (`:1335`); `reloaded` still requires a receipt from the newly loaded code.
- **tsc/tests.** `npx tsc --noEmit` exit 0; 374/374 pass; the four new tests fail with fixes 1+3 reverted.

## Test quality (new tests)

Tests 6–9 (`team-reload.test.ts:118-181`) are real and guard R1 (restoration retains + re-claim), lead skip (R1), R2 (no inspection, lead inbox empty, record stays interrupted/live), and the negative space of `ownReload`. Gaps: no `undefined` token case (N1); no different-identity negative; no lead `session_start{reload}` with a mocked tmux adapter asserting zero spawns (test 6 calls `restoreTeamPanes` directly, test 7 relies on the "requires tmux" message being absent); no `team_wait` across a peer's reload (R3); no stranded-marker/failed-reload scenario (N2); previous gaps (host refusal, superseded request, most `reloadIsSafe` branches) remain.

## Docs versus code

Accurate: `docs/reference.md` Team Reload section (request/receipt, due-ness without the PID clause, `reloading` marker, re-claim conditions, lead skip, `pending (reloading)`, "re-claiming refreshes the member's own session and pane metadata"), `docs/guide.md`, CHANGELOG entry, README/AGENTS/skills (unchanged, still accurate).

Inaccurate or incomplete:
- `docs/reference.md:340` and CHANGELOG "Any reload, manual or team-wide, now keeps the member live" — true only where a process start token exists (Linux). On other platforms the reload detaches the member (N1).
- No doc mentions the stranded-`reloading` state after a failed reload or how to recover from it (N2), nor the downgrade constraint (N3).

## Speculative concerns (not verified)

- Real reload duration and the exact failure modes of `_resourceLoader.reload()` in Pi 1.1.0 were not exercised (Pi CLI out of scope); N2 reasoning is from the dist sources.
- Linux containers with `hidepid` or restricted `/proc` would also yield an undefined token and hit N1; not tested.

## Limits

Read-only re-audit; no commits, installs, Pi CLI, tmux, network, or live `~/.pi` mutation. Only this file was written in the repository. Reproductions live only in `/tmp/pi-teams-audit/extensions/audit-repro2.test.ts`.

---

# Third audit of the N1–N3 fix, 2026-10-17 (task 31)

The sections above (task 29 report, task 30 re-audit) are retained unchanged as history. Line numbers refer to the working tree at third-audit time.

## Verdict

**Ready to commit, with two P3 documentation corrections recommended (D1, D2) and no code defects found.** N1 is closed on tokenless hosts; the `reloading` marker does not open a takeover path; the defined-token Linux path, legacy/handoff/recovery-token paths, and the null-`previous` first-claim path are unchanged or correctly guarded; quiescence and `team_wait` behaviour are unchanged apart from the added `(reloading extension code)` annotation. N2 and N3 are addressed as described.

## Identity and scope

- Same auditor and model as tasks 29/30 (`reload-auditor`, `cursor/claude-fable-5-1`, thinking `medium`).
- Repo `/home/liontree/pi-teams`, branch `feat/team-quiescence-check`, HEAD `38e0f6f`. Audited fingerprints: `extensions/index.ts` md5 `bc6587b74a…`, `src/utils/team-session.ts` `79e6e691b8…`, `src/utils/runtime.ts` `566ec7cf12…`, `src/utils/quiescence.ts` `25712be432…`, `extensions/team-reload.test.ts` `3c7b6701a2…`; plus the `docs/reference.md`, `docs/guide.md`, `CHANGELOG.md` diffs.
- Commands run in the repo (read-only): `npx tsc --noEmit` (exit 0), `node node_modules/vitest/vitest.mjs run` (29 files / 376 tests passed).
- Reproductions and the mutation experiment ran only in a fresh copy at `/tmp/pi-teams-audit` (`extensions/audit-repro3.test.ts`, 9 scenarios, all passing = behaviour as described below). The copy's `team-session.ts` was restored afterwards; repo md5s unchanged.

## Disposition of task-30 findings

| ID | Status | Evidence |
|----|--------|----------|
| N1 P1 tokenless reload strands member | **Closed** | `src/utils/team-session.ts:166-172`: `ownReload = sameProcessReload && previous.pid === pid && (tokenProvesProcess \|\| markerProvesProcess) && sessionId/sessionFile match`, where `markerProvesProcess` requires both tokens `undefined` and `previous.reloading === true`. Repro `T1` (full extension path, `getProcessStartToken` mocked `undefined`): shutdown(reload) writes `reloading: true` + numeric `reloadingSince`; start(reload) re-claims with no `blocked` notice; marker and `reloadingSince` cleared; a message appended afterwards is delivered by the new poller within one tick. Repro `T2`: tokenless interrupted member reloads and stays `interrupted/paused`. Repro `T9`: tokenless lead and peer reloading together spawn nothing and both re-claim. New tests 10 and 11 (`team-reload.test.ts:182-215`) guard this; **verified** both fail (others pass) when the marker clause is replaced by `false` in the `/tmp` copy. |
| N2 P3 stranded marker invisible | **Closed** | `runtime.ts:63-65` adds `reloadingSince`; written at `extensions/index.ts:1565-1566`, cleared at `team-session.ts:180`; surfaced in `memberSnapshot` (`extensions/index.ts:1710-1711`, so `team_status` and `check_teammate`), in `QuiescenceMemberView` (`quiescence.ts:39,259`) and in `formatInspection` (`quiescence.ts:201`). Repro `T8`: `team_status` JSON contains `"reloading":true` and `reloadingSince` for the peer; `check_teammate` contains `reloading`; the admitted inspection line reads `peer (teammate): alive idle (reloading extension code)`. `docs/guide.md:310` documents recovery (fix code, reload the pane). |
| N3 P3 downgrade constraint | **Closed** | `docs/reference.md:343` and CHANGELOG state that downgrading below this version requires quitting the pane, not `/reload`, and describe the tokenless identity basis (PID + session + marker). |

## Claims checked and found correct

- **Null `previous` guard.** `tokenProvesProcess`, `markerProvesProcess` and `ownReload` all start with `!!previous &&` (`team-session.ts:166,168,170`); the "another live process" check already required `previous` (`:173-174`). A first claim with no runtime record takes the pre-existing `assertNoOrphanLivePid` path unchanged. `tsc` is clean, so no optional-chaining gap remains.
- **No takeover via the marker.** To reach `ownReload` a claimant must (a) pass `sameSession(member.session, identity)` first (`:158-160`, repro: different conversation at the same PID is rejected with `no exact saved Pi session mapping`, test 11 and `T6`), (b) start with `reason === "reload"` (only Pi's `AgentSession.reload` emits it, `agent-session.js:2939,2966`; `/new`, `/resume`, `/fork` carry their own reasons, so an ordinary foreign process never gets `sameProcessReload`, `T6`), (c) hold the same PID (`T6`: different PID rejected), and (d) on tokenless hosts find `reloading === true`, which only this extension's own reload shutdown writes and which the claim consumes (test 11 "marker consumed"). Two live processes cannot share a PID, so the only way a *different* process satisfies (a)–(d) is PID reuse after the original died *and* a resume of the exact same conversation *and* a manual `/reload` there — at that point it is the legitimate owner of that conversation, not a takeover. Faking `reloading: true` requires write access to the team's runtime directory, which already grants full control of every lease; no new trust boundary is crossed.
- **PID reuse / `alive()` tokenless.** `isRuntimeProcessAlive` returning `true` for a recycled PID without a token is pre-existing behaviour on tokenless hosts (it already blocked recovery of a dead member whose PID was reused). The marker does not widen this: it is only consulted together with `sameProcessReload`, the same PID and the same conversation. Repro `T5`: crash mid-reload (marker left, PID dead) → `restoreTeamPanes` launches one recovery pane; the recovery child's claim (recovery token, `alive` false) succeeds and clears `reloading`/`reloadingSince`.
- **Defined-token Linux path unchanged.** `tokenProvesProcess` is exactly the task-30 condition (`defined && equal`). Test 9 (wrong PID / wrong token / missing flag) still passes. `T3` confirms both token-direction mismatches (record defined, input `undefined`; record `undefined`, input defined) are rejected — see speculative note below.
- **Upgrade path.** Old code's shutdown wrote `activity: stopped, detached: true`; `!previous.detached` is false so the new claim passes, token or not (`T4`).
- **Legacy/handoff/recovery-token paths.** `ownedLegacy` (`:142-144`), `handoff` (`:140-141`), `manualLegacy` (`:148-157`) and the recovery-token reservation check (`:137-139`) are byte-identical to HEAD. `ownedLegacy` still accepts `undefined === undefined` tokens without a marker (`T7` passes). This is pre-existing committed behaviour, gated by `legacyReload` (reload + env hint), `!member.session`, same PID and same `sessionId`/`sessionFile`; on a tokenless host it is marginally more permissive than `ownReload` but it only applies to members that have never been mapped to a Pi session, i.e. the one-time migration case. I consider it consistent enough and not worth tightening (the marker would also be present on a legacy reload, so adding the requirement would be harmless; optional).
- **Quiescence / `team_wait` unchanged.** `quiescenceGate` and `classifyTeamWaitPeer` do not read `reloading`; the only behavioural diff in `quiescence.ts` is the view field and the `formatInspection` suffix. `T8` shows the lead's own poller still admits exactly one inspection for an idle member mid-reload (as before the fix), annotated. Interrupted members behave as in the task-30 R2/R3 repros.
- **Runtime merge/normalise.** `mergeRuntimeStatus` and `normalizeRuntimeStatus` spread unknown fields, so `reloading`/`reloadingSince` survive heartbeats and legacy normalisation; the claim's explicit `undefined` drops them from the JSON.
- **Author's test and count claims.** 376/376 pass; `tsc` exit 0; the two N1 tests fail with the marker path removed.

## New findings

No code defects verified. Two documentation inaccuracies:

### D1 — P3: `docs/reference.md:341` "no quiescence inspection is admitted" (for a reloading member) is misleading

The reloading member's own shutdown admits none (that was R2), but the *lead's* poller still counts an idle reloading member as idle and can admit an inspection while it is mid-reload — repro `T8` produces exactly such an inspection, which is why `formatInspection` now carries the `(reloading extension code)` suffix. Suggested wording: "its own reload shutdown admits no inspection; an idle reloading member still counts as idle for the lead's inspection, which is annotated `reloading extension code`."

### D2 — P3: `docs/reference.md:343` says a stranded member can be re-claimed "or `/team-reload` from the lead"

A stranded member has no pi-teams extension instance, so it has no coordination poller to see `reload/request.json`; only a manual `/reload` in that pane (after fixing the code on disk) re-claims. `docs/guide.md:310` is correct on this point. Remove the `/team-reload` alternative from the reference sentence.

Minor wording (no ID): `docs/guide.md:310` says the frozen timestamp shows "in `/team-reload status` and `team_status`"; `/team-reload status` prints only `pending (reloading)` (`extensions/index.ts:1335`), the timestamp is in `team_status`/`check_teammate`.

## Test quality (new tests)

Tests 10–11 are real: 10 drives the full extension path with `getProcessStartToken` mocked `undefined` and asserts the absence of `Team recovery blocked`, marker cleared, new `instanceId`; 11 asserts marker-consumed and different-conversation negatives. Remaining gaps (unchanged from task 30, none blocking): no lead `session_start{reload}` with a tmux mock asserting zero spawns; no `team_wait` across a peer reload; no stranded-marker scenario asserting the `team_status`/inspection annotation (covered only by my `/tmp` repro `T8`); no upgrade-path (`detached` record) claim test.

## Speculative concerns (not verified)

- Token availability changing within one process (Linux `/proc` readable at start but not at reload, or the reverse) strands the member (`T3`). Both directions require `/proc/<pid>/stat` readability to flip mid-process, which I have no evidence happens in practice; recoverable by quitting the pane. Not counted as a defect.
- On tokenless hosts a dead member whose PID was recycled by an unrelated process is still not restorable automatically (pre-existing, not introduced here).
- Real Pi 1.1.0 reload duration and failure modes remain unexercised (Pi CLI out of scope).

## Limits

Read-only third audit; no commits, installs, Pi CLI, tmux, network, or live `~/.pi` mutation. Only this file was written in the repository. Reproductions live only in `/tmp/pi-teams-audit/extensions/audit-repro3.test.ts`.
