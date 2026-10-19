# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **Windows Terminal CLI compatibility**: Integrate the upstream WSL launch bridge, encoded PowerShell payloads, `-w 0 split-pane`, decimal split sizes and `-w -1 new-tab` windows. Remove `wt list` and the incorrect use of `WT_SESSION` as a window ID. WSL children preserve the lead's distribution, user, PATH and Node runtime; registered session restoration still uses the exact saved session file.
- **Intentional WSL shutdowns**: Carry upstream `prepareShutdown` markers into the guarded shutdown path, after lease ownership and process identity are confirmed. Bridge errors keep their nonzero exit status unless a stop was intentional. Bulk close on Windows Terminal and Zellij remains guarded until reliable pane closure is implemented.
- **Pi relaunch paths**: Reuse the lead's exact runtime executable and correctly quote POSIX/PowerShell paths, including Nix store paths and paths containing spaces or apostrophes.
- **Conversation retention on dissolution**: Fresh worker sessions use Pi's own persistent per-project session storage, not deletable team directories. `team_shutdown` still removes roster/tasks/mail, but leaves conversation history/model state available for manual `/resume` without automatically restoring membership. SDK-generated IDs/headers remain preallocated before first spawn; known recorded paths are not guessed or migrated.
- **Abort inspection release**: Releasing an accepted quiescence inspection after an aborted run is now a retained, retried metadata duty. A transient coordinator write failure no longer strands the durable `accepted` record: cleanup retries with capped backoff while the session is paused without starting a model or admitting an inspection. A later normal settlement never acknowledges an aborted inspection, and a successful release still requires a fresh inspection on a later run.
- **Role guidance on every run**: Team lead and teammate instructions are refreshed for each new prompt instead of disappearing after the first run. Teammate model/thinking metadata is re-read on each refresh.
- **Structured prompt composition**: Use a dedicated `pi_teams` section on current Pi versions instead of forcing a complete system prompt. This preserves magic-context's guidance in either extension load order. Keep the legacy prompt-return fallback for API compatibility.
- **Interrupted teammates**: Preserve an `interrupted` activity on cancellation without sending an idle notification or auto-delivering inbox messages. A live interrupted peer keeps `team_wait` open until it resumes, stops, dies, or the wait receives a message, times out, or is cancelled. A direct user prompt in the paused session resumes execution.

### Changed
- **Quiescence fallback instead of routine idle notices**: A teammate settling to `idle` no longer sends a per-member notice to the lead. A formal dispatch instead arms one team-wide fallback: when every live member is idle with no queued work, unread mail, unknown inbox acceptance, or active wait, pi-teams admits one inspection tagged with the latest unchecked work generation. The inspection lists members, faults, and tasks and is explicitly an inspection opportunity, never a completion report. Aborting the lead run releases its acceptance without checking the generation, and the release is retried after transient storage failures until the durable record is gone; a successful release still requires a fresh inspection on a later run. Only a normal leader settlement after actually accepting a fresh inspection records it checked. Explicit reports and task notifications are still delivered immediately.
- **Pi 1.x support**: Require Pi `>=1.1.0 <2` and develop/typecheck against Pi `1.1.0`. The minimum host must expose `agent_settled.aborted` for interruption-aware coordination.
- **Host-provided dependencies**: Declare Pi AI and TypeBox as peer dependencies with development copies for tests, avoiding duplicate runtime installations.
- Document the user-level magic-context subprocess extension isolation setting.

### Added
- **Change a live teammate's model from the lead**: `/team-model <teammate> <provider/model> [thinking]` writes a request that the teammate extension applies with Pi's `setModel`. The teammate model is never asked, so a model with no quota can still be replaced. An in-flight turn keeps the old model until it ends. The command does not abort, resume a paused session, or open a work generation. `/team-model status` reports the result. Unknown models and missing provider authentication are recorded as refusals.
- **Windows Terminal in WSL without tmux**: Detect Windows Terminal WSL sessions and start panes or windows using the same Linux distribution/user. Encoded launch payloads protect quoting and environment values. WT's `-w 0` targets the current/recent window; it is not a guarantee of exact lead-window selection when multiple windows are open. Closing panes on Windows Terminal and Zellij is still unsupported by the bulk commands.
- **Close teammate panes without dissolving the team**: `/team-close` closes every live teammate pane in one step and keeps roster, tasks, and inbox. Only the live lead of that team can close or shut it down, including the `team_shutdown` tool. Already-stopped, detached, and dead members are skipped, and shutdown uses that same skip. A pending recovery launch is cancelled so its child cannot attach. `SIGKILL` requires a start token that was read and matches; a lost runtime lease does not kill the pane. Windows Terminal and Zellij cannot close panes. When a teammate or pending launch still needs closing, those commands refuse without marking members stopped or deleting the team; an already stopped team can still be dissolved. A lost runtime lease also stops replacement and approved-shutdown cleanup from claiming the process was closed, and a pending separate window is closed even when it has no pane id. The lead pane stays open. Panes return on the next original-lead attach or `/team-resume`. Busy runs are killed; Pi sessions stay resumable. `/team-shutdown` is that close plus deletion of roster, tasks, and inbox. Conversation history is kept.
- **Team-wide reload**: `/team-reload` in the lead session asks every live member to run Pi's own `/reload`. Each session reloads itself from its poller only when it is safe: busy runs finish first and are never interrupted. Pending inbox delivery, unknown acceptance, inspection acknowledgement/release, and active waits all defer the reload. Interrupted sessions reload and stay paused. Any reload, manual or team-wide, now keeps the member live (`reloading`, same PID and activity) instead of publishing it as stopped, so a concurrent lead reload cannot restore a duplicate pane, admit a false quiescence fault, or end a wait early; a lead's own reload skips pane restoration (`/team-resume` retries it). After the reload the new code re-claims the session by process identity: with a Linux process start token the token must match; on other platforms the matching live PID and session plus the `reloading` marker written by the shutdown (a failed reload that leaves the marker behind is recovered by fixing the code and reloading again; downgrading below this version requires quitting the pane, not `/reload`). A per-member receipt written by the newly loaded code shows who is current; `/team-reload status` lists `reloaded`/`pending` without issuing a new request. Reload is not dispatch: tasks, mail, and work generations are untouched. It only loads code already on disk, and sessions still running an older pi-teams without this feature must be reloaded manually once.
- **Persistent team session recovery**: Bind actual Pi session IDs/files before worker launch and confirm at startup. Resuming the original lead reconnects its inbox and restores missing roster teammates' original sessions in tmux panes, keeping live peers, paused state, mail/tasks, and formal work generations. Model/thinking history wins over obsolete spawn defaults; no assignments or continuation prompts are replayed. Manual quit retains roster recovery intent; only explicit removal/shutdown prevents restoration. Missing/corrupt/unmapped sessions fail visibly with data preserved. `/team-resume <team>` provides narrow dead-legacy-lead association or current-lead pane retry, never force takeover. New/fork/clone sessions do not inherit ownership; launch reservations and runtime/session guards protect against duplicates and stale callbacks.
- **Formal work generations**: `delegate_task` and a successful `create_predefined_team` worker launch open one work generation. Reusing a live teammate through `delegate_task` opens a new generation for follow-up work. Team creation, draft tasks, direct prompts, model changes, status polling, ordinary `team_message`, progress updates, and acknowledgements do not open a generation; an ordinary continuation message does not re-arm the fallback.
- **Teammate defaults from Pi agent settings**: pi-teams reads `~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json` when that environment variable is set:
  - `teammateDefaultModel` (optional `teammateDefaultProvider` if the model is bare)
  - `teammateDefaultThinkingLevel`
  - Model priority: tool/agent model → team `defaultModel` → settings teammate model → bare `pi` (leader Pi defaults)
  - Thinking priority: tool/agent thinking → settings teammate thinking → bare `pi` (leader Pi defaults); this is independent of `defaultModel`
- **`max` thinking level for teammates**: Extended allowed thinking levels to include `max`, matching pi's current thinking tiers (`off` → `max`).

## [0.9.14] - 2025-04-03

### Fixed
- **cmux adapter spawn**: Fixed teammate spawning under cmux terminal (#17)
  - cmux's `new-split` silently ignores `--command` flag, leaving spawned panes empty
  - Now uses multi-step flow: snapshot surfaces → split → poll for new surface → respawn-pane with command
  - Same proven pattern used by pi-cmux for split commands
  - Thanks to @ziahm6638 for the fix

- **Predefined teams path alignment**: Fixed global teams.yaml path to match README documentation (#15)
  - README documents `~/.pi/teams.yaml` as global location, but code was using `~/.pi/agent/teams.yaml`
  - Now prefers documented path with fallback to legacy path for backwards compatibility
  - Thanks to @berkinory for the fix

### Added
- **xhigh thinking level for teammates**: Extended `spawn_teammate` thinking levels to include `xhigh` (#16)
  - Previously capped at `high` even though pi supports `xhigh` for deep reasoning
  - Enables teammate orchestration for architecture work and deep reviews
  - Thanks to @ziahm6638 for the contribution

## [0.9.12] - 2025-03-20

### Fixed
- **Improved shim-based install support**: Enhanced `getPiLaunchCommand()` to better handle Volta and other shim-based toolchains (#13)
  - Detects script files by extension (.js, .mjs, .cjs, .ts, .mts, .cts) and path pattern
  - Explicitly excludes `node` and `bun` from execPath fallback
  - Falls back to `pi` from PATH for shim-based installs, which is more reliable
  - Thanks to the contributor for the comprehensive fix

## [0.9.11] - 2025-03-20

### Fixed
- **Regression fix for Node-based installs**: Fixed a regression introduced in v0.9.9 that broke regular Node-based pi installs (#10)
  - Previous fix prioritized `process.execPath` which points to the Node interpreter, not the pi script
  - Now checks if `argv[1]` is a real "pi" file on disk before falling back to `execPath`
  - Correctly handles both Bun-compiled binaries and regular Node installs
  - Thanks to @jacek-schefler for reporting and providing the fix

## [0.9.10] - 2025-03-20

### Fixed
- **Windows PowerShell compatibility**: Added fallback to Windows PowerShell 5.1 (`powershell`) when PowerShell Core (`pwsh`) is not available (#12)
  - Windows adapter now auto-detects available PowerShell at runtime
  - Prefers PowerShell Core (pwsh) if installed, falls back to built-in Windows PowerShell
  - Users without PowerShell Core installed can now use pi-teams on Windows

## [0.9.9] - 2025-03-19

### Fixed
- **Bun-compiled binary support**: Fixed spawning teammates when pi is compiled as a Bun binary (#10)
  - Added `getPiLaunchCommand()` helper to detect and handle Bun-compiled binaries
  - Bun binaries have `process.argv[1]` pointing to virtual `/$bunfs/root/pi` path
  - Now uses `process.execPath` which works for both compiled binaries and regular Node environments
  - Fixes "node /$bunfs/root/pi" error when spawning teammates in compiled mode

## [0.9.8] - 2025-03-17

### Added
- **Save Teams as Templates**: Convert runtime teams into reusable predefined team templates (#7)
  - New `save_team_as_template` tool to save any runtime team as a template
  - New `list_runtime_teams` tool to see available teams that can be saved
  - Creates agent definition files (`.md`) with frontmatter for each teammate
  - Updates `teams.yaml` with the new template entry
  - Supports both `user` (global) and `project` (local) scope
  - Enables the workflow: Create → Use → Save → Reuse

### Changed
- Updated README with comprehensive documentation for the save-to-template workflow
- Added helper functions to `predefined-teams.ts`: `saveTeamTemplate`, `generateAgentMarkdown`, `generateTeamsYamlWithTemplate`, `listRuntimeTeams`

## [0.9.7] - 2025-03-17

### Added
- **Automatic cleanup of orphaned agent session folders** (#cleanup)
  - New `cleanupAgentSessionFolders()` utility function to remove stale `~/.pi/agent/teams/` entries
  - `team_shutdown` now automatically cleans up agent sessions older than 1 hour
  - New `cleanup_agent_sessions` tool for manual cleanup with configurable max age
  - Prevents accumulation of orphaned agent session folders (186+ folders were found in some environments)

### Changed
- `team_shutdown` now reports the number of cleaned agent session folders in its output

## [0.9.6] - 2025-03-17

### Added
- **Predefined Teams**: Define reusable team templates in `teams.yaml` files (#6)
  - Create `~/.pi/teams.yaml` (global) or `.pi/teams.yaml` (project-local) to define team presets
  - Define agent configurations in `~/.pi/agent/agents/` or `.pi/agents/` with frontmatter
  - New tools: `list_predefined_teams`, `list_predefined_agents`, `create_predefined_team`
  - Agent definitions support: name, description, tools, model, thinking, and custom prompt
  - Project-local definitions override global definitions

### Changed
- Improved agent discovery with support for both `.md` files and `SKILL.md` in subdirectories

## [0.9.5] - 2026-03-17

### Fixed
- `spawn_teammate` now kills existing teammate with same name before spawning (#1)
- Handles the case where user aborts mid-execution, changes model, and continues
- Prevents duplicate teammate entries and broken communication after model switch

## [0.9.4] - 2026-03-17

### Fixed
- Auto-cleanup of stale teams when `team_create` is called with an existing team name (#1)
- Old teammate panes/windows are now properly killed before creating a new team

### Added
- `isPidAlive()` utility to check if a process is still running
- `cleanupStaleTeam()` function to clean up dead team state (kills panes, removes files)
- Automatic detection of stale lead sessions via PID checking

## [0.9.3] - 2026-03-17

### Fixed
- Team leads now automatically subscribe to their inbox and poll for messages (#9)
- Leads no longer need to call `spawn_lead_window` just to receive messages from teammates
- Lead session is registered via PID tracking when `team_create` is called

### Changed
- Inbox polling now runs for both team leads and teammates (any agent with team context)
- Added `findLeadTeamForSession()` to detect lead membership without environment variables
- Added `registerLeadSession()` to track which session is the lead for a team
- Added `leadSessionPath()` to paths module for lead session file location

## [0.9.2] - 2026-03-17

### Fixed
- CmuxAdapter is now properly registered in the terminal registry (#8)
- CmuxAdapter detection now defensively checks for tmux/Zellij to avoid false positives in nested environments

### Added
- Comprehensive test suite for CmuxAdapter (25 tests covering all adapter methods)

## [0.9.1] - 2026-03-17

### Fixed
- Tmux teammate spawning now correctly targets the originating pane/window
- Prevents teammates from appearing in wrong tmux window when client context changes
- Layout commands (`set-window-option`, `select-layout`) now target the correct window
- `setTitle()` now explicitly targets the current pane

### Added
- `anchorPaneId` option to `SpawnOptions` for explicit pane targeting
- Tests for `TmuxAdapter` with pane targeting scenarios

## [0.9.0] - 2026-03-17

### Added
- Runtime status telemetry for teammate health checks
- New `runtime.ts` utility module for tracking agent status
- Heartbeat mechanism for teammate monitoring with configurable stale timeout
- Tests for runtime utilities (`runtime.test.ts`)

### Changed
- Improved teammate bootstrap process with better health check reliability
- Enhanced teammate readiness tracking during startup

## [0.8.7] - 2026-02-27

### Changed
- Bug fixes and stability improvements

## [0.8.6] - 2026-02-27

### Added
- Smart model resolution with OAuth provider priority

### Changed
- Implemented separate OS windows mode with persistent titles for iTerm2

## [0.8.0] - 2026-02-27

### Added
- WezTerm terminal support
- CMUX terminal adapter with split-pane support

### Changed
- Refactored terminal support to modular adapter pattern
- Removed Kitty terminal support
