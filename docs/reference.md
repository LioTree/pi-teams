# pi-teams Tool Reference

## Scope: the current main conversation

No explicit team creation, naming, or selection is needed. The first `delegate_task` or `create_predefined_team` call creates an internal collaboration record. The exact original Pi session ID **and** canonical session file bind its members, tasks, and messages. Two main conversations in the same directory remain isolated; `/new`, `/fork`, and `/clone` do not inherit membership.

On session-scoped tools, omit `team_name`. It is an optional compatibility parameter that must match the attached collaboration, not a selector for another one. `team_create` and `list_runtime_teams` remain registered but hidden and unreachable by the model. Legacy named records still attach to their original conversations. Command/tool names containing `team` remain for compatibility.

Read-only tools and messages do not create a collaboration. Before the first dispatch, they report that no collaboration is attached. Template dispatch is live-lead-only and validates the template/terminal before creating a record. Creation writes the exact main-session binding atomically. Older partial internal records can recover only their matching deterministic session id, with just the lead member and no live old owner. A moved session file is reported with its recorded path, never silently retargeted.

## Delegation and templates

### delegate_task

Create and assign an `in_progress` task, store its assignment in the inbox, and spawn or reuse a teammate. Returns after dispatch; call `team_wait` separately.

Required: `teammate_name`, `cwd`, `task_subject`, `task_description`.

Optional:
- `prompt`: additional instructions.
- `reuse`: `existing` (default), `replace`, or `error`.
- `model`, `thinking`: new-member overrides, only when explicitly requested by the user.
- `separate_window`: request a separate OS window where supported.
- `team_name`: compatibility alias for the attached collaboration.

`existing` retains the original Pi conversation, including a stopped/hidden member. A new delegation is an explicit reopen: it opens that original session and changes its window intent to open. A pending, unconfirmed launch is not duplicated. Recovery faults preserve task/mail/session evidence and are returned explicitly. `replace` explicitly requests a fresh conversation; lease loss prevents replacement.

```javascript
delegate_task({
  teammate_name: "reviewer", cwd: "/path/to/project",
  task_subject: "Review authentication", task_description: "Check authorization boundaries"
})
team_wait({})
```

Model defaults: explicit model → existing collaboration default → `teammateDefaultModel` / `teammateDefaultProvider` → Pi defaults. Thinking: explicit thinking → `teammateDefaultThinkingLevel` → Pi defaults. A template agent's explicit settings take priority. Omit overrides unless the user requests them; do not select them based on task difficulty. Reusing an existing conversation does not replace its saved/live model or thinking.

### create_predefined_team

Launch a collaboration template in the current main conversation. Required: `predefined_team`, `cwd`. Optional: `default_model`, `separate_windows`, compatibility `team_name`.

Templates come from `~/.pi/teams.yaml` and project `.pi/teams.yaml`; agent definitions come from `~/.pi/agent/agents/` and `.pi/agents/`. Existing named teammates are reused through their original sessions. Successful dispatch arms a work generation. Omit `default_model` unless explicitly requested.

### list_predefined_teams / list_predefined_agents

List available templates or agent definitions; no collaboration setup is required.

### save_team_as_template

Save the current collaboration's teammates as reusable agent definitions and a `teams.yaml` entry. Required: `template_name`. Optional: `description`, `scope` (`user` default, or `project`), compatibility `team_name`. No runtime-team selection is needed.

## Messages and waiting

### team_message

Required: `to` (teammate name, `team-lead`, or `all`), `content`. Optional: `summary`, `color`, compatibility `team_name`.

Messages remain stored for a closed teammate; they never open a pane. An interrupted session remains paused until a direct user prompt in that session.

### team_wait

Optional: positive finite `timeout_seconds`, compatibility `team_name`. Omit the timeout for an indefinite wait. Available to every member.

Returns `outcome` (`message`, `no_active_agents`, or `timeout`), `messages`, `waitedMs`, `timedOut`, and peer state when available. A live interrupted peer is non-progress-capable but keeps an indefinite wait open. Explicit timeouts include paused time. The caller's AbortSignal cancels normally.

After delegation, the lead waits rather than duplicating assigned work. Teammates wait only for a genuine outstanding dependency after messaging its owner, not merely to become idle.

Idle inbox delivery polls about once per second. Busy or interrupted sessions are not injected; an active wait consumes its own mail. Unknown host acceptance remains single-flight and unread, is not automatically resent, and is not a confirmed failure. Matching delivery evidence can acknowledge the stored batch; an interruption does not acknowledge it.

## Tasks

All task tools accept optional compatibility `team_name`; normally omit it.

- `task_list({})`: list tasks.
- `task_read({ task_id })`: read a task.
- `task_claim({ task_id })`: atomically claim an unassigned task for this member.
- `task_complete({ task_id, summary? })`: complete owned work (or lead-authorized work), running `.pi/team-hooks/task_completed.sh` before committing completion. A failed hook leaves it incomplete.

Normal statuses: `pending`, `in_progress`, `completed`, `deleted`. Legacy records are returned as stored, not rewritten on reads. Closing a pane, receiving an inspection, or restoring a conversation never completes a task.

## Status and model control

### team_status / check_teammate

`team_status({})` returns the member/task/runtime snapshot. `check_teammate({ agent_name })` checks one member. Both accept optional compatibility `team_name`.

Liveness is separate from activity: `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, `stopped`. `progressCapable`, startup `stalled`, unread mail, reload status/timestamp, unknown inbox acceptance, and recovery results are exposed. A member's `windowIntent` is independent of runtime activity. Missing intent on legacy records means open; `recoveryMode` is `auto` for open and `manual` for closed.

### team_set_model

Required: `agent_name`. Optional: `model` (`provider/model`), `thinking` (requires model), compatibility `team_name`. Only the exact live lead may change a model.

Supplying model submits a request and returns `pending`, not success. Query again without model/thinking: `no_request`, `pending`, `applied`, or `refused` with error. Confirm `applied` before claiming success. No teammate model response is required. An in-flight turn keeps its old model; interruption stays paused. This neither opens a window nor dispatches work.

Manual commands: `/team-model <member> <provider/model> [thinking]`, `/team-model status`.

## Pane intent, close, and recovery

### Window intent

Membership keeps conversation/task/mail recovery possible; it does not require a visible window. `Member.windowIntent` stores `state` (`open`/`closed`), monotonic `epoch`, `changedAt`, and `reason`. Legacy absence means open.

| Action | Window behavior |
|---|---|
| Restore original main conversation | Open only members with open intent |
| Close one member via `/team-close <member>` or `team_close` | Keep that member closed across later recovery |
| Confirm tmux pane loss while its lead is alive | Keep it closed; manual close and crash are not reliably distinguishable |
| Whole `/team-close` | Stop panes but preserve each member's prior intent |
| Explicit `/team-resume <member>` or `team_resume` | Open the original conversation, set intent open |
| New delegation to an existing closed member | Open the original conversation and deliver the new assignment |
| Ordinary message/status/model change/reload | Never open a closed pane |

Pane-loss intent requires a successful tmux pane listing. Command failure is unknown, foreign adapter IDs are not inspected as tmux panes, and a missing/unverifiable lead anchor suppresses member-specific inference. Before whole close, a final pane snapshot catches a manual close that occurred before the next poll. The close operation suppresses inference from its own pane removal. Example: A closed, B open → whole close → resume original lead → only B opens. Collective exit after the lead stops does not retrospectively mark everyone hidden.

### team_close

Optional `agent_name`: close one member and keep the lead attached. Omit it to close all teammates, then request the lead Pi's exit to its shell. The lead pane stays. Optional compatibility `team_name`.

Use only when the user requests closing panes, never merely because work finished. A close preserves membership, tasks, inbox, and Pi history. Busy work is stopped mid-run, not completed. A pending recovery launch is cancelled so a stale child cannot attach.

Only the exact original lead session with its current live runtime lease may close panes. Lease loss prevents terminal kill. `SIGKILL` requires a matching pid file and a readable matching process-start token; otherwise the signal is skipped. Terminal close failure restores the prior runtime/intent where still owned and keeps the lead attached. Already stopped/dead/detached members are not killed again. Windows Terminal and Zellij cannot close panes: when a live member or pending launch needs closing, the operation refuses without marking members stopped. An already stopped collaboration can still be deleted explicitly.

### team_resume

Optional `agent_name`: reopen that member's original session. Omit it to explicitly reopen all missing members, **including hidden ones**. Optional compatibility `team_name`. User-requested pane recovery only; not dispatch, no replay/continuation prompt, no model override. Live owners are never force-replaced. If the original process still lives but its pane is missing/unverifiable, explicit reopen reports `blocked` and preserves closed intent; retry after the process exits. It does not falsely report a window opened or start a second copy.

Slash commands: `/team-resume [member]` for the attached main conversation. The legacy `/team-resume <team> [member]` remains available for the original bound lead. An unmapped legacy lead requires explicit association with `/team-resume <team>` and no live old runtime/advisory owner; mappings are never guessed from recent chats or cwd. Associate unmapped legacy records before first dispatch. If this conversation already owns a new collaboration, use a separate saved main conversation for legacy association, or explicitly dissolve the new collaboration first; the command reports both records without silently moving membership.

### /team-shutdown confirm

User command only, no model deletion tool. Close required teammate panes first; only after every required close succeeds, delete collaboration roster/tasks/mail. Without `confirm`, do nothing. Keep Pi conversation JSONL files in normal persistent session storage. They remain manually resumable without reconstructing deleted membership.

Unexpected stops/pane losses send one lead inbox notice per known instance; requested closes do not repeat that notice. A notice is neither completion nor a work generation.

### Recovery guarantees and limits

Known original sessions require a confirmed ID/path binding, existing cwd, readable well-framed JSONL, and exclusive runtime admission. Missing/corrupt/unmapped sessions remain blocked with data preserved; no fresh-chat substitution. Startup restoration is one bounded pass, not a restart loop. Automatic pane restoration currently requires tmux. The original cwd/agent directory/trust option and saved model/thinking history are retained via `--session`, without replaying historical work. Context recovery does not undo filesystem or background-process side effects.

Per-launch nonces prevent duplicate launches after unknown outcomes. An exact nonce-matched pane can reconcile pending registration. An unknown outcome without such evidence remains blocked. See [recovery design](design/team-session-recovery.md).

## Reload and window handoff

`/team-reload` asks every live member to reload code already on disk when safe; `/team-reload status` queries receipts. Busy turns finish first, inbox/inspection obligations and active waits defer reload, interrupted sessions reload and stay paused. No tasks/mail/generations change. Reloading preserves PID/activity and publishes `reloading` / `reloadingSince`, not stopped. Same-process reclamation requires matching process and conversation identity; tokenless hosts additionally require that process's reload marker. The lead's reload does not restore panes. A stranded extension that failed to load needs manual `/reload` in its own pane.

`spawn_lead_window({ cwd? })` moves lead ownership to a separate OS window where supported, using an explicit handoff and shutting down the old lead after success. Optional compatibility `team_name`.

## Quiescence inspection

`delegate_task` and successful template dispatch open a work generation. Ordinary messages, direct user turns, status/model/reload/close/resume do not. When everyone is quiescent, one inspection may cover the latest unchecked generation. It lists members, faults, and tasks; it is not a completion report and never completes tasks. Stopped/dead members are faults, not successes.

Only a normally settled leader run that actually accepted the inspection can check its generation, under the current runtime lease and accepted-obligation guard. Abort releases the obligation without checking it; storage-failure release/ACK retries preserve ownership. Unrelated settlements cannot check an unseen inspection. For further work, formally delegate again; an ordinary continuation message does not re-arm this fallback.

## Storage and settings

Internal coordination data stays in `~/.pi/teams/<internal-id>/` (`config.json`, `inboxes/`, `runtime/`, reload and coordination records) and tasks in `~/.pi/tasks/<internal-id>/`. The id is an implementation detail, not a user-managed team name. Pi chat histories remain outside these deletable directories. JSON mutations use instance-fenced locking; do not delete lock files belonging to live owners.

Settings are read from `settings.json` under the actual Pi agent directory (`PI_CODING_AGENT_DIR` or default `~/.pi/agent`). Teammate defaults: `teammateDefaultProvider`, `teammateDefaultModel`, `teammateDefaultThinkingLevel`. `TMUX`, `TMUX_PANE`, `ZELLIJ`, and terminal-specific environment identify the adapter. Internal membership environment is only a hint; exact saved session identity establishes authority.

`cleanup_agent_sessions({ max_age_hours? })` cleans orphaned legacy agent-session folders; it is not team deletion or normal Pi conversation deletion.
