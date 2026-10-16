# pi-teams Tool Reference

Complete documentation of all tools, parameters, and automated behavior.

---

## Table of Contents

- [Team Management](#team-management)
- [Teammates](#teammates)
- [Local Control Command](#local-control-command)
- [Task Management](#task-management)
- [Messaging](#messaging)
- [Automated Behavior](#automated-behavior)
- [Runtime Activity](#runtime-activity)
- [Task Statuses](#task-statuses)
- [Configuration & Data](#configuration--data)

---

## Team Management

### team_create

Start a new team with optional default model.

**Parameters**:
- `team_name` (required): Name for the team
- `description` (optional): Team description
- `default_model` (optional): Default AI model for all teammates (e.g., `gpt-4o`, `haiku`, `glm-4.7`)

**Examples**:
```javascript
team_create({ team_name: "my-team" })
team_create({ team_name: "research", default_model: "gpt-4o" })
```

---

## Teammates

### check_teammate

Check a teammate's process liveness, coordination activity, and unread messages.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (required): Name of the teammate to check

**Returns**: Status information including:
- `alive`: Whether the teammate process/pane/window is still running
- `activity`: One of `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, or `stopped`
- `progressCapable`: Whether this member can currently make progress for another member's `team_wait`. A live `interrupted` member is never progress-capable, even with unread mail
- `stalled`: Whether a startup or queued state has exceeded its startup grace period. Live `interrupted` state does not become stalled with age
- `controlMode`: `team` (default collaboration) or `user` (human takeover), independent of execution activity
- `control`: `{ mode, heldReports, heldIdle, releasePending }`, a durable report-outbox snapshot; it is not inbox acceptance telemetry
- `unreadCount`: Number of unread inbox messages
- `runtime`: Raw activity telemetry (timestamps, pid, last error)

Liveness and activity are independent: an alive process may be deliberately `waiting`, naturally `idle`, or `interrupted` after the user aborted that session. None of those means it can complete work for another waiting member. `interrupted` also does not auto-resume.

**Example**:
```javascript
check_teammate({ team_name: "my-team", agent_name: "security-bot" })
```

---

### process_shutdown_approved

Initiate orderly shutdown for a finished teammate.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (required): Name of the teammate to shut down

**Example**:
```javascript
process_shutdown_approved({ team_name: "my-team", agent_name: "security-bot" })
```

---

## Local Control Command

### /team-mode [team|user|flush]

Only available locally in a live teammate pane, not as a tool, remote control, leader command, or unbound session command. Argument completion and `/team-mode` help are available. It runs during busy work without waiting for idle, aborting, resuming, changing model, or starting a model call.

| Command | Effect |
| --- | --- |
| `/team-mode` | Show current mode, held-report counts, release-pending state, and usage |
| `/team-mode user` | Human takes continuous control of the same working session, across multiple ordinary prompts/tools/model changes |
| `/team-mode team` | Explicitly release held reports and hand back; **not task completion**, and no automatic resume of an interrupted run |
| `/team-mode flush` | Explicitly release reports but keep the current mode (normally `user`) |

A persistent UI status shows `Control: USER`/`Control: TEAM` separately from delivery diagnostics. Activity remains truthful: normal human work is still `running`/`idle`, not `interrupted`.

In `user` mode, the harness holds that member's ordinary idle notice, explicit leader reports, task-completion notification, and broadcast's leader recipient. Other peer recipients still deliver. Idle inbox auto-injection does not start the member; unread mail stays pending. Direct human prompts work, and an **already-active explicit dependency `team_wait`** can still consume mail. Switching mode cannot unsend a report or revoke an already-handed-to-host inbox request. Unknown attempts stay single-flight/unread; accepted ACK retry remains metadata-only and is not paused merely by user control.

### Control persistence and delivery limits

The local record is `~/.pi/teams/<team>/control/<member>.json`. Ownership and pending reports survive ordinary Pi restart and a new runtime lease for the same team/member name; stale-instance callbacks cannot release them. Intentional stop/removal ends ownership but retains pending reports for an explicitly flushed replacement; team deletion removes them. Dead/stopped members do not hold `team_wait`, but a persisted user-owned name still rejects delegation until local handback or intentional removal. No policy silently turns a crash into permission to overwrite human work.

Handback/flush prepares a durable batch ID before mailbox append, includes latest known activity/task states plus actual held content, and coalesces redundant idle snapshots only. Progress is not a result, and an empty release explicitly says no completion report was provided. Repeated unchanged operations do not duplicate the handoff; an old settled handler cannot add a second idle for the covered run. A still-running run's later completion is a distinct event.

Release errors retain pending intent, show an honest UI error, and require explicit retry. A retry dedupes the same persisted ID even if the leader already read it. A previously prepared batch is immutable: retry may finish it and release newer reports in a separate batch, rather than erase new content or alter already-consumed mail. Delivery dedupe assumes that control records and inbox history are retained; it is not exactly-once model execution, crash-proof filesystem durability, or recovery after manual history deletion. Inbox host acceptance still follows its existing separate protocol.

`task_complete` stores a notification intent in the task's optional `completionNotice` before sending. Hooks and task status commit normally. If notification storage fails after completion, the task is still completed; the next explicit local flush/handback recovers that notice, deduping raw and batched deliveries. The original send can still be waiting on control when recovery happens; it checks those same retained receipts rather than delivering or holding the recovered notice again. Do not re-complete the task to retry notification.

---

## Task Management

### Recommended Semantic Workflow

Use these semantic tools for normal coordination:
- `delegate_task`: create a task, assign it, and spawn or reuse the teammate in one call, returning immediately
- `team_message`: send to one teammate, the lead, or everyone
- `team_wait`: block until a message arrives, no peer can make progress, or an optional timeout expires
- `task_claim` / `task_complete`: self-claim work and complete owned tasks

---

### delegate_task

Create a task, assign it to a teammate, and spawn or reuse that teammate as needed.

**Parameters**:
- `team_name` (required): Name of the team
- `teammate_name` (required): Teammate to assign
- `cwd` (required): Working directory if the teammate must be spawned
- `task_subject` (required): Task title
- `task_description` (required): Task details
- `prompt` (optional): Extra instructions sent with the task
- `model` / `thinking` (optional): Teammate runtime settings when spawning
- `reuse` (optional): `existing`, `replace`, or `error`. Default: `existing`
- `separate_window` (optional): Spawn in a separate OS window when supported

**Behavior**:
- Rejects a user-controlled member before creating tasks, spawning, replacing, or changing its model; local handback or intentional removal is required
- Reuses an existing live teammate by default
- Replaces a dead same-name teammate automatically unless its persisted ownership is `user`
- Only restarts a live same-name teammate when `reuse: "replace"` is explicit
- Creates and assigns an `in_progress` task, sends an inbox message with the task id, then spawns if needed
- Returns immediately after delegation; call `team_wait` separately when the caller should block

**Example**:
```javascript
delegate_task({
  team_name: "my-team",
  teammate_name: "security-bot",
  cwd: "/path/to/project",
  task_subject: "Audit auth endpoints",
  task_description: "Review all authentication endpoints for SQL injection vulnerabilities"
})
```

---

### task_list

List all tasks and their current status.

**Parameters**:
- `team_name` (required): Name of the team

**Returns**: Array of all tasks with their current status, owners, and details.

**Example**:
```javascript
task_list({ team_name: "my-team" })
```

---

### task_read

Get full details of a specific task.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task to retrieve

**Returns**: Full task object including:
- Subject and description
- Status and owner
- Blocked relationships

**Example**:
```javascript
task_read({ team_name: "my-team", task_id: "task_abc123" })
```

---

### task_claim

Claim an unassigned task for the current agent using a task file lock.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task to claim

**Behavior**:
- Fails if the task is already assigned to another agent
- Sets the current agent as owner
- Sets status to `in_progress`

---

### task_complete

Mark the current agent's task complete.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task to complete
- `summary` (optional): Completion summary stored in task metadata

**Behavior**:
- Only the task owner or lead can complete an assigned task
- Task status must be `in_progress`
- Runs `.pi/team-hooks/task_completed.sh` before writing `completed`
- If the hook fails, the task remains unchanged
- Sends the lead a wake-up inbox message when completed by a teammate in `team` mode; in `user` mode the notification is held, while hooks/status still commit
- Persists `completionNotice` with the task so an initial notification failure can be recovered by explicit local flush/handback

---

## Messaging

### team_message

Send a message to one teammate, the lead, or everyone.

**Parameters**:
- `team_name` (required): Name of the team
- `to` (required): Recipient name, `team-lead`, or `all`
- `content` (required): Full message content
- `summary` (optional): Summary. Defaults to the first line of content
- `color` (optional): Message color

In `user` mode, a report to `team-lead` is held, not delivered; the tool reports that disposition. A broadcast still delivers to other peers while holding only the leader recipient. Explicit local flush/handback is the exception.

**Example**:
```javascript
team_message({
  team_name: "my-team",
  to: "all",
  content: "The API endpoint has changed to /v2."
})
```

---

### team_wait

Block the current member while another member is doing work. This is available to both the lead and teammates.

**Parameters**:
- `team_name` (required): Name of the team
- `timeout_seconds` (optional): Positive maximum wait time. Omit it to wait indefinitely

**Returns**:
- `outcome`: `message`, `no_active_agents`, or `timeout`
- `messages`: Messages consumed from the caller's inbox, or an empty array for other outcomes
- `waitedMs`: Elapsed wait time
- `timedOut`: Whether the optional timeout expired
- `members`: A snapshot of relevant member liveness and activity when available

Messages win over activity checks. Otherwise, the wait returns `no_active_agents` after two consecutive checks, about one second apart, find no other progress-capable member and no live `interrupted` or user-controlled peer. Alive members in fresh `starting`, fresh `queued`, `running`, or a still-unknown startup state are progress-capable, as is a live waiting/idle peer with unread mail. `waiting`, `idle`, `stopped`, and dead members without unread mail are not. A live `interrupted` member is not progress-capable even with unread mail, and that mail does not auto-resume the session, but the member keeps an indefinite wait open. Dead or `stopped` members do not. Starting, queued, and unknown states have a 60-second grace period; after that they are stalled even if an undeliverable message remains unread. That grace and the runtime staleness deadline do not apply to a live `interrupted` member, and a live `running` member has no arbitrary work timeout. An explicit timeout still expires while a peer is interrupted; the clock includes the paused time. Aborting the local wait still rejects promptly. Outcomes remain `message`, `no_active_agents`, and `timeout`. A live user-controlled peer suspends inactivity without making queued idle mail progress-capable. Actual `running` work still progresses; an already-active `waiting` member with mail can consume it. Dead/stopped/replaced instances do not hold the wait. Messages, explicit timeout, and caller abort retain priority.

**Examples**:
```javascript
// Long-lived barrier: waits as long as a running teammate needs.
team_wait({ team_name: "my-team" })

// Bounded wait when the caller has a real deadline.
team_wait({ team_name: "my-team", timeout_seconds: 600 })
```

Leads should call this after delegation instead of continuing the delegated work. After a return, perform coordination only; if peers remain active, call it again. A teammate should use it only for a real dependency, after sending the dependency request with `team_message`; ordinary idle inbox delivery does not require `team_wait`.

## Automated Behavior

### Initial Assignment

When a teammate is spawned, they automatically:
1. Enter the `starting` activity state
2. Begin checking their inbox for the assignment already sent by `delegate_task`
3. Receive the actual unread message as soon as their session is idle

---

### Idle Polling

If a teammate is idle in `team` control mode, pi-teams checks for new messages about once per second and injects at most one unread message. `sendUserMessage` returns before Pi accepts the prompt. That void return, a timer, a missing error, model selection, or an unrelated run is not acceptance.

An attempt whose acceptance is unknown stays single-flight in that live process. The message stays unread, and later idle polls do not inject that copy or a later batch. pi-teams does not automatically resend it. After a short delay the session shows a local waiting state and records `inboxAwaitingConfirmation` on its runtime lease, including the message IDs. That note means acceptance is unknown. It is not a confirmed failure and it is not a remote retry control.

The batch is marked read only after Pi emits `message_end` for the user message containing `[pi-teams inbox delivery]` and that batch's `Message-ID`, and only if the acknowledgement commit still owns a live unpaused lease. That confirmation clears the unknown-acceptance diagnostic immediately, even if the mailbox acknowledgement then fails. A failed acknowledgement stays a separate metadata retry. It does not inject the prompt again, and interruption pauses that retry without acknowledging. A later direct run resumes the metadata acknowledgement only. Stop, shutdown, or lease loss before the commit leaves the mail unread.

A preflight rejection or handled input is not a distinct signal on this void host API, so those attempts also stay unknown and unread. A direct prompt in the same process does not reset an unknown attempt. Starting a new process is deliberate human recovery and can submit the still-unread message again. That is not exactly-once delivery, and it is not a guarantee that every future Pi 1.x host or restart confirms acceptance the same way.

If the teammate is busy, messages stay unread until its next idle delivery. While an unknown attempt is outstanding, idle polls do not inject that attempt again or start a later batch. If it is blocked inside `team_wait`, the active wait consumes the message and resumes the agent. This keeps teammates responsive without asking them to call `team_wait` just to idle.

An `interrupted` session is not polled. Ordinary `team_message` and broadcast delivery leave it interrupted, and the unread messages are not injected or acknowledged. A direct user prompt starts a new run and clears `interrupted`. It does not resend an attempt whose acceptance is still unknown. Selecting a model does not start execution. There is no remote resume API. Local `/team-mode` ownership is separate from interruption: neither handback nor flush resumes an interrupted run.

---

### Automated Hooks

When a task's status changes to `completed`, pi-teams automatically executes:

`.pi/team-hooks/task_completed.sh`

The hook receives the task data as a JSON string as the first argument.

**Common hook uses**:
- Run test suite
- Run linting
- Notify external systems (Slack, email)
- Trigger deployments
- Generate reports

**See [Usage Guide](guide.md#hook-system) for detailed examples.**

---

### Context Injection

Each teammate is given a custom system prompt that includes:
- Their role and instructions
- Team context (team name, member list)
- Available tools
- Team environment guidelines

This ensures teammates understand their responsibilities and can work autonomously.

---

## Runtime Activity

Activity describes coordination state separately from process liveness:

- `starting`: The member session is launching
- `queued`: A member has unread work queued for delivery; user ownership can hold that delivery
- `running`: The Pi agent is actively processing or performing work
- `waiting`: The member is blocked in `team_wait` on a real dependency
- `idle`: The Pi agent has settled and is ready for new work
- `interrupted`: The user aborted the session. Task ownership and status are unchanged, unread inbox messages stay unread, and the ordinary idle notification is suppressed. The session is not idle and will not auto-resume
- `stopped`: The member has shut down

`team_status` and `check_teammate` expose both liveness and activity. This lets `team_wait` distinguish a long-running job from a team in which every remaining member is idle or waiting, and from a live interrupted peer that must keep an indefinite wait open. A teammate becoming idle in `team` mode also sends a structured notification to the lead with its unfinished owned tasks. In `user` mode that snapshot is held and coalesced. An interrupted settlement does not generate an idle notification. Read tools expose `controlMode` and the `control` outbox snapshot separately; a user-controlled idle peer is not falsely reported as interrupted or progress-capable.

---

## Task Statuses

### pending

Task is created but not yet assigned or started.

### in_progress

Task is actively being worked on by the assigned teammate.

### completed

Task is finished. Status change triggers the `task_completed.sh` hook.

### deleted

Task is removed from the active task list. Still preserved in data history.

Legacy task records are returned as stored. Reading tasks or team configuration does not rewrite or remove legacy plan-approval data.

---

## Configuration & Data

### Data Storage

All pi-teams data is stored in your home directory under `~/.pi/`:

```
~/.pi/
├── teams/
│   └── <team-name>/
│       ├── config.json       # Team configuration and member list
│       ├── inboxes/<agent-name>.json # Retained per-agent message arrays
│       ├── runtime/<agent-name>.json # Instance-owned execution telemetry
│       └── control/<agent-name>.json # Durable ownership and held leader reports
└── tasks/
    └── <team-name>/
        └── <task-id>.json    # Individual task files, including saved notice intent
```

### Team Configuration (config.json)

```json
{
  "name": "my-team",
  "description": "Code review team",
  "defaultModel": "gpt-4o",
  "members": [
    {
      "name": "security-bot",
      "model": "gpt-4o",
      "thinking": "medium"
    },
    {
      "name": "frontend-dev",
      "model": "haiku",
      "thinking": "low"
    }
  ]
}
```

### Task File (task_*.json)

```json
{
  "id": "task_abc123",
  "subject": "Audit auth endpoints",
  "description": "Review all authentication endpoints for vulnerabilities",
  "status": "in_progress",
  "owner": "security-bot",
  "blocks": [],
  "blockedBy": [],
  "activeForm": "Auditing auth endpoints",
  "createdAt": "2024-02-22T10:00:00Z",
  "updatedAt": "2024-02-22T10:30:00Z"
}
```

### Inbox File (inboxes/<agent-name>.json)

```json
[
  {
    "id": "msg_def456",
    "from": "team-lead",
    "text": "Please focus on the auth module first",
    "summary": "Focus on auth module",
    "timestamp": "2024-02-22T10:15:00Z",
    "read": false
  }
]
```

Control-release messages may also contain `releaseReportIds`, the original held-report IDs. Keep read inbox history and control state if you need release retries to dedupe; deleting either is not a supported exactly-once recovery procedure.

---

## Environment Variables

pi-teams respects the following environment variables:

- `ZELLIJ`: Automatically detected when running inside Zellij. Enables Zellij pane management.
- `TMUX`: Automatically detected when running inside tmux. Enables tmux pane management.
- `PI_DEFAULT_THINKING_LEVEL`: Default thinking level for spawned teammates if not specified (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

---

## Terminal Integration

### tmux Detection

If the `TMUX` environment variable is set, pi-teams uses `tmux split-window` to create panes.

**Layout**: Large lead pane on the left, teammates stacked on the right.

### Zellij Detection

If the `ZELLIJ` environment variable is set, pi-teams uses `zellij run` to create panes.

**Layout**: Same as tmux - large lead pane on left, teammates on right.

### iTerm2 Detection

If neither tmux nor Zellij is detected, and you're on macOS with iTerm2, pi-teams uses AppleScript to split the window.

**Layout**: Same as tmux/Zellij - large lead pane on left, teammates on right.

**Requirements**:
- macOS
- iTerm2 terminal
- Not inside tmux or Zellij

---

## Error Handling

### Lock Files

pi-teams locks individual JSON paths with a `.lock` suffix, for example:

```text
~/.pi/teams/<team>/control/<member>.json.lock
~/.pi/teams/<team>/inboxes/<member>.json.lock
~/.pi/teams/<team>/runtime/<member>.json.lock
~/.pi/tasks/<team>/<task-id>.json.lock
```

Ordinary lock acquisition retries about 5 seconds; the existing generic lock may reclaim a file older than 30 seconds based on mtime, not proof of process death. Control locks instead retain a PID/start token and nonce: a live owner is not stolen just because its operation lasts 30 seconds. Dead-owner or partial crash locks become reclaimable after that age. Control acquisition/reclamation uses a synchronous, nonblocking try under the runtime mutex; it never waits for control while holding runtime. The normal nested order remains control → recipient inbox → source runtime. On platforms without process-start tokens, PID-reuse recovery is conservative.

### Race Conditions

The locking system prevents race conditions when multiple teammates try to update tasks or send messages simultaneously.

### Recovery

Do not delete a live lock to force handback. Inspect the owning process, mode, and retained reports first; stop or restart the affected session deliberately before operator repair. Filesystem faults that leave an owner lock behind may require that recovery rather than repeated immediate retries. Never discard control/inbox records as a notification retry: they carry the dedupe evidence.

---

## Performance Considerations

### Idle Polling Overhead

Teammates poll their inboxes about once per second only while idle or already queued for delivery. Each poll is a local JSON read. Busy, stopped, interrupted, and user-controlled sessions are not polled for injection. A session in `team_wait` consumes messages through that active wait.

### Lock Timeout

A contending acquisition normally fails after about 5 seconds; control ownership is not a work timeout and a live control lock is not reclaimed by age. Retry explicitly after the current operation or storage fault is resolved.

### Message Storage

Messages are retained JSON arrays in the team's `inboxes/` directory. Archive by copying rather than deleting live history needed for control-release dedupe:

```bash
# Archive old messages
cp -R ~/.pi/teams/my-team/inboxes/ /safe/archive/my-team-2024-02-22-inboxes/
```
