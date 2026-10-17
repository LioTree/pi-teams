# pi-teams Tool Reference

Complete documentation of all tools, parameters, and automated behavior.

---

## Table of Contents

- [Team Management](#team-management)
- [Teammates](#teammates)
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
- Reuses an existing live teammate by default
- Replaces a dead same-name teammate automatically
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
- Sends the lead a wake-up inbox message when completed by a teammate

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

Messages win over activity checks. Otherwise, the wait returns `no_active_agents` after two consecutive checks, about one second apart, find no other progress-capable member and no live `interrupted` peer. Alive members in fresh `starting`, fresh `queued`, `running`, or a still-unknown startup state are progress-capable, as is a live waiting/idle peer with unread mail. `waiting`, `idle`, `stopped`, and dead members without unread mail are not. A live `interrupted` member is not progress-capable even with unread mail, and that mail does not auto-resume the session, but the member keeps an indefinite wait open. Dead or `stopped` members do not. Starting, queued, and unknown states have a 60-second grace period; after that they are stalled even if an undeliverable message remains unread. That grace and the runtime staleness deadline do not apply to a live `interrupted` member, and a live `running` member has no arbitrary work timeout. An explicit timeout still expires while a peer is interrupted; the clock includes the paused time. Aborting the local wait still rejects promptly. Outcomes remain `message`, `no_active_agents`, and `timeout`.

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

If a teammate is idle, pi-teams checks for new messages about once per second and injects at most one unread message. `sendUserMessage` returns before Pi accepts the prompt. That void return, a timer, a missing error, model selection, or an unrelated run is not acceptance.

An attempt whose acceptance is unknown stays single-flight in that live process. The message stays unread, and later idle polls do not inject that copy or a later batch. pi-teams does not automatically resend it. After a short delay the session shows a local waiting state and records `inboxAwaitingConfirmation` on its runtime lease, including the message IDs. That note means acceptance is unknown. It is not a confirmed failure and it is not a remote retry control.

The batch is marked read only after Pi emits `message_end` for the user message containing `[pi-teams inbox delivery]` and that batch's `Message-ID`, and only if the acknowledgement commit still owns a live unpaused lease. That confirmation clears the unknown-acceptance diagnostic immediately, even if the mailbox acknowledgement then fails. A failed acknowledgement stays a separate metadata retry. It does not inject the prompt again, and interruption pauses that retry without acknowledging. A later direct run resumes the metadata acknowledgement only. Stop, shutdown, or lease loss before the commit leaves the mail unread.

A preflight rejection or handled input is not a distinct signal on this void host API, so those attempts also stay unknown and unread. A direct prompt in the same process does not reset an unknown attempt. Starting a new process is deliberate human recovery, not an acceptance receipt. Persisted unknown-acceptance diagnostics stay single-flight rather than being silently cleared or resubmitted. If a crash happened before that evidence was stored, a new process may submit still-unread mail again; this is not exactly-once delivery or a guarantee about future Pi 1.x hosts.

If the teammate is busy, messages stay unread until its next idle delivery. While an unknown attempt is outstanding, idle polls do not inject that attempt again or start a later batch. If it is blocked inside `team_wait`, the active wait consumes the message and resumes the agent. This keeps teammates responsive without asking them to call `team_wait` just to idle.

An `interrupted` session is not polled. Ordinary `team_message` and broadcast delivery leave it interrupted, and the unread messages are not injected or acknowledged. A direct user prompt starts a new run and clears `interrupted`. It does not resend an attempt whose acceptance is still unknown. Selecting a model does not start execution. There is no remote resume API or takeover UI.

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
- `queued`: An idle member has unread work queued for delivery
- `running`: The Pi agent is actively processing or performing work
- `waiting`: The member is blocked in `team_wait` on a real dependency
- `idle`: The Pi agent has settled and is ready for new work
- `interrupted`: The user aborted the session. Task ownership and status are unchanged, unread inbox messages stay unread, and settlement publishes no idle notification. The session is not idle and will not auto-resume
- `stopped`: The member has shut down

`team_status` and `check_teammate` expose both liveness and activity. This lets `team_wait` distinguish a long-running job from a team in which every remaining member is idle or waiting, and from a live interrupted peer that must keep an indefinite wait open. Routine per-teammate idle notices are not sent; the team-wide quiescence fallback below wakes the lead once per formally dispatched work generation when the whole team is quiescent.

---

## Persistent Session Recovery

Teams bind each member to its actual Pi session ID and canonical absolute file. Resuming the original conversation can reclaim a dead/detached owner's lease; a live owner is refused. New, forked, cloned, or unrelated same-PID conversations do not inherit ownership. The explicit `spawn_lead_window` token handoff remains supported.

On original lead attachment, one bounded tmux pass restores missing roster peers using their original `--session` file/cwd/agent directory/trust override, without model/thinking defaults, assignment replay, or synthetic continuation. Existing live processes are retained even if their pane ID is stale. Recovery does not dispatch work or change tasks/mail/generations. Interrupted state and known unknown-acceptance diagnostics survive startup; they do not become proof of acceptance or an automatic resume.

Roster membership is recovery intent, including manual quit/Ctrl+D/terminal loss. Only explicit removal or destructive `team_shutdown` prevents restoration. Worker chats are allocated in Pi's persistent session storage outside team/task directories; dissolution removes roster/tasks/inbox, not conversation history. Manual `/resume` does not recreate removed membership. Session context restoration does not roll back background tools or external effects. Missing/corrupt/unconfirmed files and unmapped legacy peers are individually blocked with data preserved. Other adapters recover the lead inbox but report missing-pane restoration unsupported.

`/team-resume <team>` explicitly associates an unmapped legacy lead only after both old runtime/advisory process authority are gone; an existing mapping must match this exact conversation. It never forces a live owner or searches chat files. A currently attached lead can use the command for a bounded pane retry. Unknown launch outcomes remain reserved and blocked unless an exact tmux nonce reconciles them; no automatic respawn loop runs.

See [the design](design/team-session-recovery.md) for migration, partial-failure, restart, and exactly-once limits.

## Team Quiescence Fallback

Formal dispatch opens one work generation. `delegate_task` (new work, follow-up, or re-dispatch of a live teammate) and a successful `create_predefined_team` worker launch open a generation. Team creation alone, draft task creation, direct user prompts, model changes, status polling, ordinary `team_message`, progress updates, and acknowledgements do not.

When every live participant is idle and no member is queued, starting, running, waiting, or interrupted, has unread mail, or has unknown inbox acceptance, pi-teams admits at most one inspection message for the latest unchecked generation. Multiple outstanding dispatches coalesce into one inspection tagged with the latest generation. Stopped or dead members do not block the check, but they are reported as faults; they never count as success.

The inspection names the generation, the member snapshot, faults, and the current task list. It is an inspection opportunity with no completion report: it never completes a task, never claims the work is done, and does not summarise the work for the lead. If a member stopped or died, the inspection exposes that as a fault to investigate.

Only an inspection that Pi actually accepted into a leader run, and whose run later settled normally, records its tagged generation as checked. The coordinator revalidates the current leader lease and the still-authorized acknowledgement obligation at the commit boundary, so a replacement lease or an acknowledgement revoked by a later abort, stop, or shutdown cannot check the generation. If that revalidation rejects an acknowledgement because the obligation was revoked, the durable `accepted` record is handed to the retryable release path instead of being stranded; a rejection because the record is no longer ours is conclusive ownership loss. An aborted run releases the acceptance without checking it; the release is retried after transient storage failures until the durable record is gone. Succeeding at that cleanup does not check anything: the next run must accept a fresh inspection before the generation can be checked, and an unrelated normal settlement never checks an inspection it did not accept.

A checked generation stays checked across later direct human turns and unrelated settlements. With no new formal dispatch, no further automatic inspections occur. To re-arm the fallback for new or follow-up work, use `delegate_task` (or the predefined-team launch); an ordinary `team_message` that says to continue does not re-arm it. Explicit reports (`team_message`, task assignment and completion notifications) are still delivered immediately and are not held or muted by this fallback.

Limits: the watermark is local coordination state in the team directory, not a distributed exactly-once protocol across restarts or machines. A retry after a storage failure reuses the reserved message ID, so it cannot create a duplicate inspection for the same admission. A corrupt watermark records nothing and surfaces as an error instead of silently rearming. An interrupted member is never resumed by this mechanism, and stopping the lead records the inspection for whichever lead session continues the team.

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
│       └── config.json      # Team configuration and member list
├── tasks/
│   └── <team-name>/
│       ├── task_*.json      # Individual task files
│       └── tasks.json       # Task index
└── messages/
    └── <team-name>/
        ├── <agent-name>.json  # Per-agent message history
        └── index.json         # Message index
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

### Message File (<agent-name>.json)

```json
{
  "messages": [
    {
      "id": "msg_def456",
      "from": "team-lead",
      "to": "security-bot",
      "content": "Please focus on the auth module first",
      "summary": "Focus on auth module",
      "timestamp": "2024-02-22T10:15:00Z",
      "read": false
    }
  ]
}
```

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

pi-teams uses lock files to prevent concurrent modifications:

```
~/.pi/teams/<team-name>/.lock
~/.pi/tasks/<team-name>/.lock
~/.pi/messages/<team-name>/.lock
```

If a lock file is stale (process no longer running), it's automatically removed after 60 seconds.

### Race Conditions

The locking system prevents race conditions when multiple teammates try to update tasks or send messages simultaneously.

### Recovery

If a lock file persists beyond 60 seconds, it's automatically cleaned up. For manual recovery:

```bash
# Remove stale lock
rm ~/.pi/teams/my-team/.lock
```

---

## Performance Considerations

### Idle Polling Overhead

Teammates poll their inboxes about once per second only while idle or already queued for delivery. Each poll is a local JSON read and also evaluates the team-wide quiescence watermark described above. Busy, stopped, and interrupted sessions are not polled for injection. A session in `team_wait` consumes messages through that active wait.

### Lock Timeout

Lock files timeout after 60 seconds. Adjust if you have very slow operations.

### Message Storage

Messages are stored as JSON. For teams with extensive message history, consider periodic cleanup:

```bash
# Archive old messages
mv ~/.pi/messages/my-team/ ~/.pi/messages-archive/my-team-2024-02-22/
```
