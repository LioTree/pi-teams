# pi-teams Tool Reference

Complete documentation of all tools, parameters, and automated behavior.

---

## Table of Contents

- [Team Management](#team-management)
- [Teammates](#teammates)
- [Task Management](#task-management)
- [Messaging](#messaging)
- [Task Planning & Approval](#task-planning--approval)
- [Automated Behavior](#automated-behavior)
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

### team_delete

Delete a team and all its data (configuration, tasks, messages).

**Parameters**:
- `team_name` (required): Name of the team to delete

**Example**:
```javascript
team_delete({ team_name: "my-team" })
```

---

### read_config

Get details about the team and its members.

**Parameters**:
- `team_name` (required): Name of the team

**Returns**: Team configuration including:
- Team name and description
- Default model
- List of members with their models and thinking levels
- Creation timestamp

**Example**:
```javascript
read_config({ team_name: "my-team" })
```

---

## Teammates

### spawn_teammate

Launch a new agent into a terminal pane with a role and instructions.

**Parameters**:
- `team_name` (required): Name of the team
- `name` (required): Friendly name for the teammate (e.g., "security-bot")
- `prompt` (required): Instructions for the teammate's role and initial task
- `cwd` (required): Working directory for the teammate
- `model` (optional): AI model for this teammate (overrides team default)
- `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `plan_mode_required` (optional): If `true`, teammate must submit plans for approval

**Model Options**:
- Any model available in your pi configuration
- Common models: `gpt-4o`, `haiku` (Anthropic), `glm-4.7`, `glm-5` (Zhipu AI)

**Thinking Levels**:
- `off`: No thinking blocks (fastest)
- `minimal`: Minimal reasoning overhead
- `low`: Light reasoning for quick decisions
- `medium`: Balanced reasoning (default)
- `high`: Extended reasoning for complex problems
- `xhigh`: Maximum available reasoning for the hardest tasks

**Examples**:
```javascript
// Basic spawn
spawn_teammate({
  team_name: "my-team",
  name: "security-bot",
  prompt: "Scan the codebase for hardcoded API keys",
  cwd: "/path/to/project"
})

// With custom model
spawn_teammate({
  team_name: "my-team",
  name: "speed-bot",
  prompt: "Run benchmarks on the API endpoints",
  cwd: "/path/to/project",
  model: "haiku"
})

// With plan approval
spawn_teammate({
  team_name: "my-team",
  name: "refactor-bot",
  prompt: "Refactor the user service",
  cwd: "/path/to/project",
  plan_mode_required: true
})

// With custom model and thinking
spawn_teammate({
  team_name: "my-team",
  name: "architect-bot",
  prompt: "Design the new feature architecture",
  cwd: "/path/to/project",
  model: "gpt-4o",
  thinking: "xhigh"
})
```

---

### check_teammate

Check if a teammate is still running or has unread messages.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (required): Name of the teammate to check

**Returns**: Status information including:
- `alive`: Whether the teammate process/pane/window is still running
- `unreadCount`: Number of unread inbox messages
- `health`: One of `healthy`, `idle`, `starting`, `stalled`, `dead`
- `agentLoopReady`: Whether the teammate has executed its inbox-read loop at least once
- `hasRecentHeartbeat`: Whether heartbeat data has been updated recently
- `startupStalled`: Detects the "alive but not consuming inbox" startup failure mode
- `runtime`: Raw runtime telemetry (timestamps, pid, last error)

**Example**:
```javascript
check_teammate({ team_name: "my-team", agent_name: "security-bot" })
```

---

### force_kill_teammate

Forcibly kill a teammate's tmux pane and remove them from the team.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (required): Name of the teammate to kill

**Example**:
```javascript
force_kill_teammate({ team_name: "my-team", agent_name: "security-bot" })
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

Prefer these higher-level tools for normal coordination:
- `delegate_task`: create a task, assign it, and spawn or reuse the teammate in one call
- `team_message`: send to one teammate, the lead, or everyone
- `team_wait`: wait for a message, plan, task completion, or all tasks being done
- `plan_submit` / `plan_review`: submit and review task plans
- `task_claim` / `task_complete`: self-claim work and complete owned tasks

The lower-level tools (`spawn_teammate`, `task_create`, `task_update`, `read_inbox`, `wait_for_inbox`) remain available for advanced/admin/debug workflows.

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
- `plan_required` (optional): If true, the task prompt tells the teammate to submit a plan before implementation
- `reuse` (optional): `existing`, `replace`, or `error`. Default: `existing`
- `wait` (optional): `none`, `plan`, or `completion`. Default: `none`
- `timeout_seconds` (optional): Timeout when waiting
- `separate_window` (optional): Spawn in a separate OS window when supported

**Behavior**:
- Reuses an existing live teammate by default
- Replaces a dead same-name teammate automatically
- Only restarts a live same-name teammate when `reuse: "replace"` is explicit
- Creates a task with optional `planRequired`, assigns it, sends an inbox prompt with the task id, then spawns if needed

**Example**:
```javascript
delegate_task({
  team_name: "my-team",
  teammate_name: "security-bot",
  cwd: "/path/to/project",
  task_subject: "Audit auth endpoints",
  task_description: "Review all authentication endpoints for SQL injection vulnerabilities",
  plan_required: true,
  wait: "plan"
})
```

---

### task_create

Create a new task for the team. Prefer `delegate_task` for normal delegation.

**Parameters**:
- `team_name` (required): Name of the team
- `subject` (required): Brief task title
- `description` (required): Detailed task description

**Example**:
```javascript
task_create({
  team_name: "my-team",
  subject: "Audit auth endpoints",
  description: "Review all authentication endpoints for SQL injection vulnerabilities"
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
- Plan (if in planning mode)
- Plan feedback (if rejected)
- Blocked relationships

**Example**:
```javascript
task_read({ team_name: "my-team", task_id: "task_abc123" })
```

---

### task_update

Low-level task status or owner update. Prefer `delegate_task`, `task_claim`, and `task_complete` for normal workflows.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task to update
- `status` (optional): New status (`pending`, `planning`, `in_progress`, `completed`, `deleted`)
- `owner` (optional): New owner (teammate name)

**Example**:
```javascript
task_update({
  team_name: "my-team",
  task_id: "task_abc123",
  status: "in_progress",
  owner: "security-bot"
})
```

**Behavior**:
- When `owner` changes to a teammate, that teammate receives a wake-up inbox message
- When status changes to `completed`, the public tool uses the same semantic completion path as `task_complete`
- Completion requires `in_progress`, enforces `planRequired`, and blocks if `.pi/team-hooks/task_completed.sh` fails
- Completion cannot be combined with owner reassignment; assign the task first, then complete it

---

### task_claim

Claim an unassigned task for the current agent using a task file lock.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task to claim

**Behavior**:
- Fails if the task is already assigned to another agent
- Sets the current agent as owner
- Sets status to `in_progress`, unless the task has `planRequired`, in which case it stays `pending` until a plan is submitted

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

### send_message

Low-level direct message tool. Prefer `team_message`.

**Parameters**:
- `team_name` (required): Name of the team
- `recipient` (required): Name of the agent receiving the message
- `content` (required): Full message content
- `summary` (required): Brief summary for message list
- `color` (optional): Message color for UI highlighting

**Example**:
```javascript
send_message({
  team_name: "my-team",
  recipient: "security-bot",
  content: "Please focus on the auth module first",
  summary: "Focus on auth module"
})
```

---

### broadcast_message

Low-level broadcast tool. Prefer `team_message({ to: "all" })`.

**Parameters**:
- `team_name` (required): Name of the team
- `content` (required): Full message content
- `summary` (required): Brief summary for message list
- `color` (optional): Message color for UI highlighting

**Use cases**:
- API endpoint changes
- Database schema updates
- Team announcements
- Priority shifts

**Example**:
```javascript
broadcast_message({
  team_name: "my-team",
  content: "The API endpoint has changed to /v2. Please update your work accordingly.",
  summary: "API endpoint changed to v2"
})
```

---

### read_inbox

Read incoming messages for an agent.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (optional): Whose inbox to read. Defaults to current agent.
- `unread_only` (optional): Only show unread messages. Default: `true`

**Returns**: Array of messages with sender, content, timestamp, and read status.

**Examples**:
```javascript
// Read my unread messages
read_inbox({ team_name: "my-team" })

// Read all messages (including read)
read_inbox({ team_name: "my-team", unread_only: false })

// Read a teammate's inbox (as lead)
read_inbox({ team_name: "my-team", agent_name: "security-bot" })
```

---

### wait_for_inbox

Block until the current agent receives unread inbox messages. Returned messages are marked as read.

**Parameters**:
- `team_name` (required): Name of the team
- `poll_interval_ms` (optional): Polling interval in milliseconds. Default: `1000`
- `timeout_seconds` (optional): Maximum time to wait. Omit to wait indefinitely

**Returns**:
- `messages`: Messages received by the current agent
- `count`: Number of returned messages
- `waitedMs`: Time spent waiting in milliseconds
- `timedOut`: Whether the optional timeout expired before any message arrived

**Behavior**:
- Validates that the target team exists and that the current agent belongs to it before waiting
- Fails immediately if the team is missing, deleted while waiting, or the agent is not a member

**Examples**:
```javascript
// Wait indefinitely for my next unread message
wait_for_inbox({ team_name: "my-team" })

// Wait up to five minutes
wait_for_inbox({ team_name: "my-team", timeout_seconds: 300 })
```

Use this after delegating work to a teammate when the Team Lead should pause until the teammate reports back.

---

### team_wait

Wait for a semantic team event.

**Parameters**:
- `team_name` (required): Name of the team
- `event` (required): `message`, `plan`, `task_completed`, or `all_tasks_done`
- `task_id` (required for `plan` and `task_completed`): Limit the wait to one task, avoiding historical task matches
- `poll_interval_ms` (optional): Polling interval in milliseconds. Default: `1000`
- `timeout_seconds` (optional): Maximum time to wait. Omit to wait indefinitely

`all_tasks_done` requires at least one task on the board; an empty team returns an error instead of waiting forever.

**Examples**:
```javascript
team_wait({ team_name: "my-team", event: "plan", task_id: "1" })
team_wait({ team_name: "my-team", event: "all_tasks_done", timeout_seconds: 600 })
```

---

## Task Planning & Approval

### plan_submit

For teammates to submit their implementation plans for approval. This tool blocks until the lead approves or rejects the plan.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task
- `plan` (required): Implementation plan description

**Behavior**:
- Updates task status to `planning`
- Saves the plan to the task
- A teammate can submit a plan only for their own task; an unowned task is assigned to the submitting teammate
- Automatically sends a wake-up inbox message to the lead when submitted by a teammate
- Lead agent can then review and approve/reject
- Waits until this specific task is approved or rejected
- Returns the latest task and evaluation result
- If the plan is approved, the task status is `in_progress` and the teammate may start implementation
- If the plan is rejected, the task remains `planning` with `planFeedback`; revise and resubmit

**Example**:
```javascript
plan_submit({
  team_name: "my-team",
  task_id: "task_abc123",
  plan: "1. Add password strength validator component\n2. Integrate with existing signup form\n3. Add unit tests using zxcvbn library"
})
```

---

### plan_review

For the lead agent to approve or reject a submitted plan.

**Parameters**:
- `team_name` (required): Name of the team
- `task_id` (required): ID of the task
- `decision` (required): `"approve"` or `"reject"`
- `feedback` (optional): Feedback message (required when rejecting)

**Behavior**:
- Only the team lead can review plans
- **Approve**: Sets task status to `in_progress`, clears any previous feedback
- **Reject**: Keeps task status as `planning` (for revision), saves feedback
- Automatically sends a wake-up inbox message to the task owner when evaluated by another agent

**Examples**:
```javascript
// Approve plan
plan_review({
  team_name: "my-team",
  task_id: "task_abc123",
  decision: "approve"
})

// Reject with feedback
plan_review({
  team_name: "my-team",
  task_id: "task_abc123",
  decision: "reject",
  feedback: "Please add more detail about error handling and edge cases"
})
```

## Automated Behavior

### Initial Greeting

When a teammate is spawned, they automatically:
1. Send a message to the lead announcing they've started
2. Begin checking their inbox for work

**Example message**: "I've started and am checking my inbox for tasks."

---

### Idle Polling

If a teammate is idle (has no active work), they automatically check for new messages every **30 seconds**.

This ensures teammates stay responsive to new tasks, messages, and task reassignments without manual intervention.

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

## Task Statuses

### pending

Task is created but not yet assigned or started.

### planning

Task is being planned. Teammate has submitted a plan and is awaiting lead approval. (Only available when `plan_mode_required` is true for the teammate)

### in_progress

Task is actively being worked on by the assigned teammate.

### completed

Task is finished. Status change triggers the `task_completed.sh` hook.

### deleted

Task is removed from the active task list. Still preserved in data history.

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
      "thinking": "medium",
      "planModeRequired": true
    },
    {
      "name": "frontend-dev",
      "model": "haiku",
      "thinking": "low",
      "planModeRequired": false
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
  "plan": "1. Scan /api/login\n2. Scan /api/register\n3. Scan /api/refresh",
  "planFeedback": null,
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

Teammates poll their inboxes every 30 seconds when idle. This is minimal overhead (one file read per poll).

### Lock Timeout

Lock files timeout after 60 seconds. Adjust if you have very slow operations.

### Message Storage

Messages are stored as JSON. For teams with extensive message history, consider periodic cleanup:

```bash
# Archive old messages
mv ~/.pi/messages/my-team/ ~/.pi/messages-archive/my-team-2024-02-22/
```
