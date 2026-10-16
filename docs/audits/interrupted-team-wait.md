# Interrupted team wait — independent final C4 repair audit, 2026-10-15

## Current verdict

**Review complete: no actionable findings within reviewed scope. C4 is resolved for the original reproduction and the additional reviewed recovery schedules; C1–C3 remain scoped resolved.** The original auditor-owned **22 expectations pass unchanged**, including the previously failing C4 case. An additional **14 independently authored C4 controls pass**. Fresh repository checks pass **24 files / 285 tests**, typecheck, and diffcheck.

This closes the scoped interrupted-team-wait implementation audit, not a global safety proof. No new product choice was made. No implementation, repository test, or other documentation was changed by this auditor. The current report sections were updated in place; the older pre-repair record below remains explicitly historical.

## Current identity, scope, and source fingerprint

- Auditor: `astra-auditor`; exact model **openai/gpt-6-astra**, thinking **high**. `PI_PROVIDER=openai`, `PI_MODEL=gpt-6-astra`, and `PI_REASONING_LEVEL=high` independently agree.
- Branch: `fix/interrupted-team-wait`; HEAD: `fbb5001b6926db28126419b306a6d42df4acc862`. Reviewed uncommitted changes versus HEAD, including both untracked test files `extensions/audit-fixes.test.ts` (**49 cases**, 14 new C4 cases) and `extensions/lifecycle.test.ts` (12 cases). Both files were read in the preceding audit; this continuation separately read the new C4 helpers/cases and changed implementation paths.
- This continuation reviewed generation-owned resume publication, ACK gating, settled-target retargeting, false/error/success completions, real-lock races, lifecycle side effects, and interactions with earlier fixes. The prior whole-change review and installed Pi documentation/host-code inspection were retained rather than repeatedly reread.
- Independent auditor identity remains `openai/gpt-6-astra` / `high`. The user-selected author finishing identity (`gpt-6.1-sol` / `xhigh`) is separate; author handoff/test claims were not substituted for independent execution.
- Both repository-installed and global host `@earendil-works/pi-coding-agent` are **1.1.0**. The approved peer floor remains **`>=1.1.0 <2`**. Tests use the repository-installed actual host prototypes. This is not certification of every future 1.x version.
- Only this report and isolated `/tmp` evidence/fixture trees were authored (current evidence: `/tmp/pi-teams-astra-c4-review/`; unchanged original fixtures: `/tmp/pi-teams-astra-final/`). No branch switch, commit/push, core-Pi edit, live team fixture, real model/provider call, or Pi CLI launch was used.

SHA-256 fingerprints:

| File | SHA-256 |
| --- | --- |
| `extensions/index.ts` | `7996d283173d10b15158620715a5fc042648c3e419fb5be860def05a945dd94b` |
| `extensions/audit-fixes.test.ts` | `3c3b2bbd9b4d971c05d96bfc2276e64463fd32aca30d5e2074ee2b84b4386ef1` |
| `extensions/lifecycle.test.ts` | `b8802827c830dcc30fa6c747afef5aa03b1e020da5fcac9a50b0fc9782e1ab39` |
| `/tmp/pi-teams-astra-c4-review/source-before.sha256` | `e67c1b95a06cc294a37737460e3d69ff47055cd7e0a407eaaeb03da11cadb167` |
| `/tmp/pi-teams-astra-c4-review/targeted.test.ts` | `55a58d7cdfc233888b43a7d0316ab621fa1b038d422c4e60747af2291481156c` |

The manifest covers every file under `src/` and `extensions/`, plus `package.json` and `package-lock.json`. A final `sha256sum -c` passed for all entries, showing implementation/tests remained unchanged throughout this continuation. Original fixture checksums also match: `audit.test.ts` = `ec13253c22045897894fed8a588e7c7565b9bfbde25b7ff303ea6958c1a665fb`; `resume-error.test.ts` = `27117bec479585b9e2f4cd8c4a7af88b17b6158b1b6dfda48d34a3970aea81fc`.

## Fresh evidence, not a replay of deleted artifacts

The former `/tmp/pi-teams-astra-singleflight/`, `/tmp/pi-teams-astra-n123/`, their 43-case suite, logs, and guard are **missing after reboot**. They were not rerun unchanged, and the historical results below are not current evidence. Necessary schedules were reconstructed from the historical report, actual source, reviewed repository regressions, and installed host code.

The preceding auditor reconstruction produced 21 cases plus the original failing C4 case. Those **22 fixtures were rerun unchanged**, not reconstructed again. The current additional **14 controls** reuse the prior isolation/extension/host plumbing with independently authored expectations. Installed `AgentSession.sendUserMessage`/`prompt`, `runAgentLoop`, and `ExtensionRunner.emit`/`emitMessageEnd` exercise acceptance and handler-error containment; fake provider calls stop before network/model use.

| Fresh check | Actual result | Evidence under `/tmp/pi-teams-astra-c4-review/` |
| --- | --- | --- |
| Original auditor suite, unchanged | Exit 0; **22/22**, two files | `original22.log`, `original22.exit`; sources remain under `/tmp/pi-teams-astra-final/` |
| Additional independent C4 controls | Exit 0; **14/14**, one file | `targeted.test.ts`, `targeted.log`, `targeted.exit` |
| Final `npm test` on unchanged repository | Exit 0; **24 files / 285 tests**, 4.93 seconds | `npm-test.log`, `npm-test.exit` |
| Final `npm run typecheck` | Exit 0 | `typecheck.log`, `typecheck.exit` |
| Final `git diff --check` | Exit 0 | `diffcheck.log`, `diffcheck.exit` |
| Source stability | Exit 0; every checksum matches | `source-before.sha256`, `source-stability.log`, `source-stability.exit` |
| Original fixture and guard stability | Exit 0; all match | `original-fixtures-before.sha256`, `original-fixtures-stability.log`, `original-fixtures-stability.exit` |
| Guard before/after comparison | Exit 0; **312 bytes before and after, byte-identical** | `guard-before.log`, `guard-after.log`, `guard-comparison.exit` |

Current invocation counts: original independent suite **1**; targeted suite **2** (initial setup failure, then 14/14); full repository suite **1**; typecheck **1**. The first targeted run reached a setup assertion at 100ms before the settled retry due at 200ms (initial start and inline settled publication both failed). Its early failures left fixture lock files and caused teardown timeouts/mock contamination. The retained `targeted-initial-setup-failed.log` and `targeted-initial-source.txt` document **6 passed / 8 failed**, not a hidden production failure. Only that setup advance and failure-safe fixture lock cleanup were corrected; behavior assertions were not weakened. The two original fixture files containing 22 expectations and all repository sources/tests were untouched.

Additional current evidence: `index-full.diff`, `targeted-cases.txt`, `plumbing.txt`, `original-home`, `targeted-home` (initial setup run), and `final-checks-home`.

All executable checks used fresh `/tmp` HOME and `PI_AGENT_DIR` values. The application-level guard blocks covered protected-path mutations (including existing symlink parents), socket/TLS/fetch connections, Pi/terminal/network subprocesses, unexpected child launches, and signals to unrelated processes. It permits the compiler/test runner, exact reviewed temporary hook scripts, and termination of isolated Vitest workers. It is **not a kernel sandbox**.

The guard is unchanged at `/tmp/pi-teams-astra-final/guard.cjs`. Its shared log contains historical denied signals/TLS attempts from earlier runs, so it is **not described as empty**. This independent continuation appended **zero denials**, including the initial targeted setup failure. Before/after copies are byte-identical. Fresh npm checks set `NPM_CONFIG_UPDATE_NOTIFIER=false`, offline mode, and the lowercase equivalents. Historical guard setup/author rerun logs remain outside this continuation's counts; no network allowance was added.

Reproduction from the repository:

```bash
AUDIT_HOME="$(mktemp -d /tmp/pi-teams-astra-final-repro-home-XXXXXX)"
HOME="$AUDIT_HOME" PI_AGENT_DIR="$AUDIT_HOME/.pi/agent" \
NODE_OPTIONS="--require=/tmp/pi-teams-astra-final/guard.cjs" \
./node_modules/.bin/vitest run --root /tmp/pi-teams-astra-final
# Expected: 22 passed, exit 0. To run the additional 14 controls instead:
# change --root to /tmp/pi-teams-astra-c4-review.
```

## Current disposition of previous findings

| Finding | Current disposition and evidence |
| --- | --- |
| Minimum host version | Approved `>=1.1.0 <2` floor is consistent across manifest, root lock metadata, and changed docs; tested host is 1.1.0. |
| F1 — ACK crosses pause/stop/replacement | Guard remains inside the actual inbox-then-runtime lock critical section; repository held-lock controls pass. Independent C1/C3 stop/replacement controls preserve unread mail. No reversed nested acquisition was found in changed paths. |
| F2 — cancellation consumes/hides mail | Fresh independent registered-tool cases cover initial read, final timeout/inactivity consumption, and cancellation after actual committed ACK. Repository tests also exercise cancellation while the actual ACK lock is held. Precommit cancellation leaves mail unread; committed messages are returned. |
| F3 / R1 — void acceptance and slow-preflight duplication | Fresh installed-host 5.5-second preflight, handled input, rejected input, and no-model cases keep one injection; unknown cases stay unread across pause/direct resume and 120 seconds of later polls. Repository's 3.5-second actual-host case also passes. |
| F4 / R2 — interrupted publication retries/generation ownership | Independent old-success/old-error/old-false completion controls preserve a newer generation's retry; repository actual-runtime-lock schedules pass. These original controls pass unchanged after C4; the additional resume-publication controls are described below. |
| N1 — accepted metadata resumes | Ordinary paused ACK and inbox-lock resume tests pass. Independent C3 verifies the real-lock race, and original/new C4 checks now verify the exceptional resume path. |
| N2 — accepted still labeled unknown while ACK fails | Independent repeated ACK-failure case clears the diagnostic independently and remains one injection. |
| N3 — old diagnostic cleanup overwrites newer state | Repository runtime-lock and local-badge ownership tests pass. Independent C2 additionally checks the delayed old clear after B replaces stale A IDs. |
| **C1 — fallback parsing failure loses ACK recovery** | **Resolved for reviewed schedules.** Whole recovery work is inside try/catch/finally (`index.ts:678–722`), with a detached rejection boundary. Independent real malformed JSON tests exercise both confirmation and timer paths for 31 seconds, then restore the file: eventual metadata ACK/backlog, no observed unhandled rejection, no accepted-prompt reinjection. Stop/foreign-lease controls stop retrying. |
| **C2 — stale old IDs block current publication** | **Resolved for reviewed schedules.** Current publisher's object/unconfirmed/lease guard is evaluated under runtime lock (`index.ts:745–759`) without refusing differing older IDs. Independent failed-A-clear/restored-writer sequence publishes B, and delayed A cleanup does not erase B. Old clear still checks ID ownership. |
| **C3 — old false ACK beats running publication** | **Resolved for specified race.** ACK finally re-evaluates the current object/state and successful generation-owned running publication rearms metadata work. Independent actual-host/real-lock t1250 resume, t1300 old zero return, t1350 running commit passes, including reabort/stop/replacement controls. No retry chain remains after those controls. |

The repository's eight C1–C3 regressions remain meaningful and pass unchanged. The **14 new author C4 cases**, independently read at `extensions/audit-fixes.test.ts:277–600`, exercise installed-host acceptance/error containment, repeated outages, actual runtime-lock running-to-settled retargeting, abort/shutdown/external-stop/replacement/new-run controls, delayed success/error/false completions, normal idle/task behavior, and unknown identity. Lock/host cases are not merely mocked desired final states; delayed helper results are explicitly controlled faults. All 49 cases in this file pass in the fresh repository run.

Approved semantics remain unchanged: live interrupted peers are not progress-capable but hold an indefinite wait without startup TTL; mail, explicit timeout, caller cancellation, stopped/dead/replacement behavior remain covered by the fresh full suite. Aborted settlement preserves tasks, suppresses idle notification, and does not acknowledge/inject mail. No new wait parameter/outcome, takeover, remote resume, or resend control was introduced.

## C4 repair verification and changed-path review

**C4 — previously P2, now scoped resolved.** The original unchanged test is `/tmp/pi-teams-astra-final/resume-error.test.ts`, `resumes accepted metadata after one failed running publication on a legitimate direct host run`.

Historical reproduction: actual host acceptance of inbox A, temporary metadata ACK failure, interruption, storage restoration, then a legitimate direct prompt with exactly one failed `running` publication. Installed `ExtensionRunner` contains the handler error and the host proceeds normally. Before repair, 60 seconds later the observation was `{activity:"interrupted",unread:1,metadataRetries:0,inboxInjections:1}`. That old failed log remains `/tmp/pi-teams-astra-final/independent-expanded.log`; it is not the current result.

**Fresh unchanged observation:**

```json
{"activity":"idle","unread":0,"metadataRetries":1,"inboxInjections":1}
```

Current log: `/tmp/pi-teams-astra-c4-review/original22.log`, exit 0. The original assertion passes without modification.

### Reviewed implementation boundaries

- `extensions/index.ts:995–1010` installs a new `PendingResume` before the initial publication. The original handler exception remains visible to installed Pi error containment, while `publishResumedActivity`'s `finally` retains retry intent.
- `index.ts:445–509` owns that intent by pending-object identity, runtime generation, local interruption/shutdown state, and running-versus-settled target. The commit predicate is checked under the existing runtime lock and again after the write await. Each completion releases only its own in-flight flag. The backoff interval caps at five seconds; retry intent has no finite-attempt cutoff.
- `index.ts:1022–1029` changes the target synchronously on normal settlement and cancels it synchronously on abort. A stale running waiter cannot publish after that target change. Settled repair reads current unread metadata and targets `queued` or `idle`; a failing inbox read keeps the obligation through `finally`.
- The false-return fallback lease read can retire only the current object after absent/stopped/foreign lease evidence. An old delayed result cannot clear a newer object. Transient thrown read/write errors preserve current recovery intent.
- `index.ts:597–604` gates accepted ACK while resume publication remains outstanding. A valid publication retires the gate and rearms metadata-only ACK. Existing mailbox object/token identity, locked ACK guard, diagnostic ownership, and no-resend rules remain intact.
- Normal settlement still excludes `interrupted` through `ROUTINE_SETTLE_ACTIVITIES` (`index.ts:432`); it gained generation/local-state checks, not a global relaxation of pause handling. Detached recovery does not replay idle notices or mutate tasks. Successful inline normal settlement retains its existing one idle notice/task description.
- Shutdown invalidates generation/resume timers before awaits. Real stopped/replacement leases reject publication, and abort preserves pause/unread mail. No public wait parameter/outcome, remote resume, takeover, automatic resend, or core-Pi change was added.

### Additional independent controls: 14 passed

The single new file `/tmp/pi-teams-astra-c4-review/targeted.test.ts` covers:

1. **Two cases:** 75 seconds of failed activity publications, covering both an active actual-host run held at the fake provider and a normally settled run. After recovery, exactly one metadata ACK; correct `running` or settled activity; no accepted replay, detached idle notice, or task mutation.
2. **One case:** a running retry held by the **actual runtime lock**, followed by normal host settlement and a **real malformed inbox file** during settled retry. No stale `running` commit or ACK while publication is blocked; file restoration yields settled publication and one ACK.
3. **Four cases:** an in-flight settled retry under the **actual runtime lock** loses to abort, shutdown, external stopped state, or lease replacement. No accepted-mail ACK, idle notice, or task mutation; old retry chains stop.
4. **Three cases:** old success/error/false completions are delayed across a newer generation whose active publication initially fails. They cannot release the new ACK gate or discard the new intent; restored storage publishes the newer active state and ACKs once.
5. **Two cases:** a thrown false-return fallback lease read preserves retry; an obsolete delayed fallback result cannot retire a newer generation. These are controlled helper-fault/gate cases, not claims that every underlying filesystem error has that exact form.
6. **One case:** an unknown attempt remains the original single-flight/unread item across failed start and settled repair, over two minutes of polling, and unrelated direct input. Only its later original confirmation ACKs it.
7. **One case:** normal inline settled repair reports the actual numeric task's existing assignment exactly once and preserves the task file byte-for-byte.

These supplement—not replace—the unchanged original 22 expectations and the author's independently reviewed 14 repository C4 regressions. No actionable defect was reproduced in this scoped final review.

## Limits and handoff

- Current counts are new independent evidence: **22 original plus 14 additional expectations**, run in two suites, not a claim that the deleted historical 43 cases were recovered or rerun.
- Actual host methods/event dispatch/agent-loop acceptance are used with mocked discovery/auth/run-driver dependencies and a fake throwing provider boundary. No live interactive production session, actual model request, terminal handoff, or restart replay was exercised. Installed host is 1.1.0; this does not certify every future 1.x host.
- Recovery and unknown-attempt identities remain process-local. A deliberate new process can replay unread mail; no cross-restart exactly-once guarantee is made.
- Faults/timers/lock schedules cover the specified cases, not every filesystem outage, scheduler ordering, corruption mode, throwing UI, third-party input transformation, or failure elsewhere in the program. Scope stayed on C4 and its changed-path regressions, rather than unlimited unrelated fault exploration. Unexecuted concerns are limits, not verified findings.
- Final checks verify unchanged implementation/tests, unchanged original auditor fixtures, zero appended guard denials, and a nonempty current report. No current finding remains open within this scope; C1–C4 have scoped verified resolutions.
- **Handoff:** task 4 is audit-complete. No further technical repair or product decision is requested by this scoped review. This is **no actionable findings within reviewed scope**, not global proof or a claim about untested deployment paths.

---

## Historical pre-repair report — superseded, retained for provenance

**Everything below is the prior audit record, not the current verdict or fresh evidence.** Its “current,” “open,” and “authoritative” labels refer to that earlier review; its `/tmp` artifacts are now missing. In particular its C1–C3-open verdict and 263-test count are superseded by the 2026-10-15 sections above.

### Historical identity, revision, approved policy

- Auditor: `astra-auditor`; exact model **openai/gpt-6-astra**, thinking **high**. Independently inspected environment agrees.
- Branch: `fix/interrupted-team-wait`; HEAD: `fbb5001b6926db28126419b306a6d42df4acc862`.
- Reviewed uncommitted implementation versus HEAD, including untracked `extensions/lifecycle.test.ts` and `extensions/audit-fixes.test.ts`. This continuation specifically reviews the new ACK flags/timers, diagnostic cleanup/publishing guards, six added regressions, and reference documentation, while rerunning the previous full independent coverage.
- Only this report and isolated `/tmp` artifacts were changed by the auditor. No repository implementation/test edit, branch switch, commit/push, core-Pi edit, live user-data mutation, model/network request, or Pi CLI launch.
- Minimum Pi **`>=1.1.0 <2`** remains approved option A. Fresh manifest/root-lock check agrees; installed host is **1.1.0**.
- Unknown delivery stays single-flight/unread in the live process; no automatic resend on timeout, unrelated lifecycle, model selection, or interrupt/direct resume. New-process recovery may replay unread mail; no exactly-once guarantee or remote retry API.
- Confirmed delivery retries only guarded mailbox metadata. Interruption pauses ACK; a later legitimate direct run resumes metadata recovery without resending. Acceptance diagnostics must distinguish unknown input from accepted-but-unacknowledged input and preserve attempt/lease ownership.

## Fresh checks and artifacts

| Check | Actual result |
| --- | --- |
| Authoritative prior independent suite, **no edits** | **Exit 0; 38/38 passed**, one file |
| Expanded independent suite | **Exit 1; 39 passed, 4 failed, 43 total**, one file; four failures represent C1–C3 |
| `npm test` | **Exit 0; 24 files passed, 263 tests passed**, duration 4.92 seconds |
| `npm run typecheck` | **Exit 0** |
| `git diff --check` | **Exit 0** |
| Source stability during final repository checks | SHA-256 checks match for extension implementation and both extension test files |

Authoritative current evidence:

- Unchanged original: `/tmp/pi-teams-astra-singleflight/audit.test.ts`
- Original replay log: `/tmp/pi-teams-astra-n123-original.log`
- Expanded executed suite: `/tmp/pi-teams-astra-n123/audit.test.ts`
- Expanded log: `/tmp/pi-teams-astra-n123-final.log`
- New test sources: `/tmp/pi-teams-astra-n123/new.txt`, `real-resume.txt`
- `/tmp/pi-teams-astra-n123-npm-test.log`
- `/tmp/pi-teams-astra-n123-typecheck.log`
- `/tmp/pi-teams-astra-n123-source-hashes.txt`
- `/tmp/pi-teams-astra-n123-checks-home-path`
- `/tmp/pi-teams-astra-n123/guard.cjs`

All runs used newly created `/tmp` HOME directories with `PI_AGENT_DIR` beneath them. The preload rejects protected `/home/liontree/.pi` mutation through its covered filesystem APIs, socket connections, and Pi CLI launches. No guard violation occurred. Fixtures redirect runtime/inbox/config/task paths to temporary trees and mock terminal access. Host tests use installed `AgentSession.prompt`/`sendUserMessage` and actual `runAgentLoop` event forwarding with a fake throwing provider boundary, never a real provider/model call. These are application-level guards, not a kernel sandbox.

Correct reproduction command from the repository uses the outside-root suite explicitly:

```bash
AUDIT_HOME="$(mktemp -d /tmp/pi-teams-audit-home-XXXXXX)"
HOME="$AUDIT_HOME" PI_AGENT_DIR="$AUDIT_HOME/.pi/agent" \
NODE_OPTIONS="--require=/tmp/pi-teams-astra-n123/guard.cjs" \
./node_modules/.bin/vitest run --root /tmp/pi-teams-astra-n123
```

## Earlier findings and verified corrections

| Finding | Current disposition |
| --- | --- |
| Minimum-version incompatibility | Resolved by approved `>=1.1.0 <2` support floor; no old-host fallback needed. |
| F1 — ACK crosses pause/stop/replacement | Prior real inbox-lock and replacement-during-read expectations pass. Inbox-then-runtime guarded synchronous commit remains the linearization point. |
| F2 — caller cancellation consumes mail | Inbox-read, actual ACK-lock entry, final timeout/inactivity cancellation, and postcommit result preservation expectations pass. |
| F3 — void send return falsely proves acceptance | Actual no-model/handled/rejected preflight preserves unread mail; matching actual user events confirm acceptance. |
| F4 / R2 — interrupted publication recovery and stale-generation retry | Original real-runtime-lock sequence and stale success/error/false-return controls pass. |
| R1 — duplicate slow preflight | Actual 3.5-second and longer slow-input schedules remain one attempt; unknown state survives unrelated runs and interrupt/resume. |
| N1 — paused accepted ACK never restarts | Original ordinary pause/resume and held-inbox expectations now pass. **C3 identifies a narrower still-broken in-flight resume ordering.** |
| N2 — accepted mail still labeled unknown during ACK errors | Original healthy-runtime-storage confirmation/ACK-failure expectation passes. **C2 covers cleanup failure followed by a later attempt.** |
| N3 — old cleanup erases a newer diagnostic | Original gated and real-runtime-lock expectations pass; added local-badge ownership test also passes. |

No previous expectation was weakened or skipped. The earlier inherited F1/F2/F3 defects were previously compared against HEAD. Current C1–C3 arise in the newly added/corrected pending-ACK/diagnostic implementation, not in HEAD's old behavior.

## Current findings

### C1 — P2: Fallback inbox read failure escapes ACK recovery and drops the retry

**Locations:** `extensions/index.ts:601-638`, especially the unprotected `messaging.readInbox` at **632**; detached retry callback at **539-545**. Real inbox parsing is in `src/utils/messaging.ts:64-96`.

**Failing test:** `recovers metadata ACK after real inbox parsing fails in both commit and fallback read`.

- Inject one unread batch, then temporarily replace its isolated inbox file with malformed JSON before matching confirmation.
- The real guarded ACK helper fails to parse it. The new catch converts that failure into `marked = 0` and continues.
- The fallback real `readInbox` also fails parsing, but it is **outside** the catch. The registered confirmation handler rejects with `SyntaxError`; no retry is scheduled.
- Restore the original valid inbox file. After ten seconds of polls, the confirmed message is still unread and there has been only one injection. Pending state blocks recovery/backlog despite healthy storage.

The test observes `{ error: 'SyntaxError', unread: 1, sends: 1 }` instead of `{ error: undefined, unread: 0, sends: 1 }`. This executes both real helpers and the real parsing failure; it does not merely mock `readInbox` to reject. A transient filesystem-read exception can reach the same branch, though that separate fault mode was not executed.

The timer callback invokes this async helper with `void` and no rejection handler. Therefore the same escaping exception from a timer invocation has an unhandled-rejection path. **The executed case proves handler rejection and lost recovery; it does not claim an observed process crash or separately executed timer-level unhandled rejection.**

**Required invariant:** All fallible ACK recovery work, including fallback reads, must retain safe metadata-only retry state on recoverable errors. Detached callbacks must not leak rejections. Do not resend accepted prompts, acknowledge during pause, or relax lease guards.

### C2 — P2: Failed old diagnostic cleanup permanently blocks publication for the current attempt

**Locations:** `extensions/index.ts:552-580` (cleanup/retry), **670-679** (publisher rejects differing stored IDs and does not recover from null result).

**Failing test:** `publishes the current unknown IDs after previous accepted diagnostic clear failed then storage recovered`.

1. First batch A remains unknown long enough to publish its runtime diagnostic.
2. Confirm A. Inject failures only for runtime writes clearing `inboxAwaitingConfirmation`; the actual mailbox ACK succeeds. A is read and retired.
3. The next idle batch B starts. While clear storage is still failing, an old A-clear retry observes B's newer token and stops scheduling itself.
4. Restore the runtime writer. B's diagnostic timer now runs, but its commit guard rejects existing A IDs. This is a null-return path, not a caught exception, so no retry/repair remains.
5. After ten additional seconds, `inboxAwaitingConfirmation.messageIds` still names **accepted/read A**, not unknown/unread B. The test also verifies B is the remaining unread item and only two batches were injected.

Only old diagnostic clears are fault-injected; mailbox writes, runtime CAS, the next attempt, and the guard evaluation use actual helpers. Storage is healthy during B's failed publication and afterward. This is a durable wrong remote diagnostic after recovery, not merely stale telemetry while the filesystem is unavailable. The local B badge may be correct, but status consumers continue seeing the wrong work item.

**Required invariant:** Current-attempt publication must be able to repair older diagnostic state after cleanup failure while still rejecting genuinely stale writers and protecting the current lease. Retiring an old attempt must not permanently strand the only cleanup/publication path. No new delivery policy is involved.

### C3 — P2: Direct resume loses ACK recovery when an older ACK is still in flight

**Locations:** `extensions/index.ts:539` (no schedule while `ackInFlight`), **625-631** (in-flight flag cleared then false-commit return without rearm), **922-934** (resume scheduling precedes awaited running publication).

**Failing tests:**

- `does not lose resumed ACK when the old in-flight guarded commit returns false after resume` — controlled completion gate.
- `does not drop resumed metadata ACK when old runtime-lock waiter wins before running publication` — **actual host acceptance and real inbox/runtime locks**, no delayed-return gate.

**Real-lock schedule:**

1. At t=1000ms an actual host turn accepts the batch; inject failure for its first mailbox ACK. The run settles normally and a metadata-only retry is scheduled.
2. Hold the inbox lock. At t=1100ms the retry starts and waits, with `ackInFlight=true`.
3. A subsequent direct run is aborted. Its runtime becomes `interrupted`; the existing in-flight ACK is not cancelled or replaced.
4. At t=1150ms hold the runtime lock and release inbox. At t=1200ms the old ACK gets inbox but waits for runtime; its next attempt is t=1300ms.
5. At t=1250ms a direct resume sets the local pause false. `scheduleAckRetry` does nothing because the old ACK is still in flight. The new run's runtime publication waits for the same lock, with its next attempt t=1350ms.
6. Release runtime at t=1299ms. The old ACK wins t=1300ms, correctly sees persisted `interrupted`, and returns zero without committing. It clears `ackInFlight`, but `commitAllowed=false` makes it return without rearming.
7. The resumed start publishes `running` at t=1350ms and completes. No ACK timer remains. After normal settlement and ten seconds of polls, the accepted batch is still unread; it was not resent.

All lock acquisitions, persisted activity checks, and mailbox commits are real. Only the initial ACK failure is injected. Actual host prompt/agent-loop acceptance occurs before the later direct-run transitions, avoiding an impossible concurrent lifecycle ordering. The additional gated test isolates the same missed-rearm invariant but is not the sole evidence.

**Required invariant:** A legitimate resume must not lose the intent to resume confirmed metadata work merely because an older attempt is in flight or runtime publication has not committed yet. Once that older operation finishes without commit, recovery must re-evaluate current ownership/pause/run state and safely rearm if appropriate. Preserve stopped/replacement rejection and never resend the prompt.

## Remaining review observations

- The six new repository tests cover ordinary N1 resume, accepted diagnostic clearing with healthy runtime storage, and old/new diagnostic ownership. They pass independently, but do not cover the post-failure fallback read, failed-old-cleanup/current-publisher recovery, or in-flight ACK versus running-publication ordering above.
- `ackInFlight`, separate ACK/diagnostic timers, ID-guarded runtime clearing, and UI token checks fix the earlier reported schedules. The added independent badge test confirms old delayed cleanup cannot wipe a newer local badge.
- Existing stopped/replacement/interrupt ACK guards, R2 ownership guards, and inbox-then-runtime lock order remain intact. Exercised lock schedules complete without deadlock; no reverse nested order was found in the modified paths. This is not a whole-program deadlock proof.
- Approved unknown single-flight behavior, blocked later idle batches, late confirmation, no automatic resend, direct-user interruption recovery, no model-select recovery, no aborted idle/task mutation, interrupted wait hold/no TTL, explicit timeout and local cancellation remain covered by the passing original 38/repository tests and prior source review.
- Public tool parameters and outcome literals are unchanged. Runtime/status diagnostic fields are additive; no remote retry/resume/takeover API or core-Pi change was introduced.
- Reference documentation now correctly states metadata-only accepted recovery and separation of unknown diagnostics from mailbox ACK. Its statements are intended invariants, not proof they hold in C1–C3. In particular, “clears ... immediately” is subject to runtime I/O/cleanup failures and should not be interpreted as a filesystem availability guarantee.
- Manifest/lock/docs still require Pi 1.1.0 or newer. The actual installed host methods are used in the suites; no claim is made for every future 1.x release.

## Limits and handoff

Pending attempt identity is in memory; human new-process recovery may replay unread mail. No global exactly-once semantics, cross-restart ledger, or exhaustive scheduler/fault guarantee is claimed. Fake timers and controlled helper faults cover the specified schedules. No live user team, terminal, real provider/model, or process handoff was exercised. Fixtures use actual host methods/event forwarding but replace selected dependencies/run-driver/provider boundaries, not a complete interactive production session.

Caller-cancellation tests establish the reported consumption/commit boundaries, not instantaneous interruption of every filesystem-lock wait or every exhausted-lock error branch. Active `team_wait` retains its documented consumption path; no exactly-once claim spans all user-directed/third-party-extension consumption paths.

**Handoff:** Task 9 is review-complete once this report is verified on disk. Current open findings are **C1, C2, C3**. Lead should delegate technical corrections separately and request a scoped re-audit; no additional product-policy decision is necessary. The auditor has stopped without changing implementation/tests.
