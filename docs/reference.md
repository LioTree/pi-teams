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
- `activity`: One of `starting`, `queued`, `running`, `waiting`, `idle`, or `stopped`
- `progressCapable`: Whether this member can currently make progress for another member's `team_wait`
- `stalled`: Whether a startup or queued state has exceeded its startup grace period
- `unreadCount`: Number of unread inbox messages
- `runtime`: Raw activity telemetry (timestamps, pid, last error)

Liveness and activity are independent: an alive process may be deliberately `waiting` or naturally `idle`, neither of which means it can complete work for another waiting member.

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

Messages win over activity checks. Otherwise, the wait returns `no_active_agents` after two consecutive checks, about one second apart, find no other progress-capable member. Alive members in fresh `starting`, fresh `queued`, `running`, or a still-unknown startup state are progress-capable, as is a live waiting/idle peer with unread mail. `waiting`, `idle`, `stopped`, and dead members without unread mail are not. Starting, queued, and unknown states have a 60-second grace period; after that they are stalled even if an undeliverable message remains unread, while a live `running` member has no arbitrary work timeout.

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

If a teammate is idle, pi-teams checks for new messages about once per second. It injects the actual message contents into Pi and marks only successfully delivered message IDs as read.

If the teammate is busy, messages stay unread until its next idle delivery. If it is blocked inside `team_wait`, the active wait consumes the message and resumes the agent. This keeps teammates responsive without asking them to call `team_wait` just to idle.

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
- `stopped`: The member has shut down

`team_status` and `check_teammate` expose both liveness and activity. This lets `team_wait` distinguish a long-running job from a team in which every remaining member is idle or waiting. A teammate becoming idle also sends a structured notification to the lead with its unfinished owned tasks.

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
- `PI_DEFAULT_THINKING_LEVEL`: Default thinking level for spawned teammates if not specified (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`).

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

Teammates poll their inboxes about once per second only while idle. Each poll is a local JSON read. Busy sessions leave queued messages unread, while a session in `team_wait` consumes messages through that active wait.

### Lock Timeout

Lock files timeout after 60 seconds. Adjust if you have very slow operations.

### Message Storage

Messages are stored as JSON. For teams with extensive message history, consider periodic cleanup:

```bash
# Archive old messages
mv ~/.pi/messages/my-team/ ~/.pi/messages-archive/my-team-2024-02-22/
```
