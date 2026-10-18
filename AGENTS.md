# pi-teams: Agent Guide 🤖

This guide explains how `pi-teams` transforms your single Pi agent into a coordinated team of specialists. It covers the roles, capabilities, and coordination patterns available to you as the **Team Lead**.

---

## 🎭 The Two Roles

In a `pi-teams` environment, there are two distinct types of agents:

### 1. The Team Lead (You)
The agent in your main terminal window. You are responsible for:
- **Strategy**: Creating the team and defining its goals.
- **Delegation**: Spawning teammates and assigning them specific roles.
- **Coordination**: Managing the shared task board and broadcasting updates.
- **Quality Control**: Reviewing teammate results and deciding follow-up work.

### 2. Teammates (The Specialists)
Agents spawned in separate panes. They are designed for:
- **Focus**: Executing specific, isolated tasks (e.g., "Security Audit", "Frontend Refactor").
- **Parallelism**: Working on multiple parts of the project simultaneously.
- **Autonomy**: Receiving inbox messages, executing assigned work, and reporting progress without constant hand-holding.

---

## 🛠 Capabilities

### 🚀 Specialist Spawning
You can delegate work to teammates with custom identities, models, and reasoning depths:
- **Custom Roles**: "Delegate a layout task to a 'CSS Expert'."
- **Model Selection**: Use `gpt-4o` for complex architecture and `haiku` for fast, repetitive tasks.
- **Thinking Levels**: Set thinking to `high`/`xhigh`/`max` for deep reasoning or `off` for maximum speed.

### 📋 Shared Task Board
A centralized source of truth for the entire team:
- **Visibility**: Everyone can see the full task list and who owns what.
- **Status Tracking**: Tasks move through `pending` ➔ `in_progress` ➔ `completed`.
- **Ownership**: Assigning a task to a teammate automatically notifies them.

### 💬 Coordination & Messaging
Communication flows naturally between team members:
- **Direct Messaging**: Send specific instructions to one teammate.
- **Broadcasts**: Announce global changes (like API updates) to everyone at once.
- **Inbox Delivery**: About once per second, an idle teammate receives the actual contents of unread inbox messages. Busy agents leave messages unread; an agent in `team_wait` consumes them through the active wait. An `interrupted` session is not polled and does not auto-resume. Unknown host acceptance stays single-flight and unread in that process; it is not automatically resent and is not a confirmed failure.
- **Blocking Waits**: Any member can call `team_wait({ team_name, timeout_seconds? })`. Omit the timeout for a long-lived barrier; it returns on a message, timeout, or when no other member can make progress. A live `interrupted` peer is not progress-capable, but it keeps an indefinite wait open until it resumes, stops, or dies.
- **Activity Tracking**: Members report `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, or `stopped`, independently from process liveness. `interrupted` means the user aborted that session. Recovery is a direct user prompt there, not a model change or remote resume.
- **Quiescence Fallback**: Routine per-teammate idle notices are replaced by one team-wide inspection per formally dispatched work generation. `delegate_task` and successful predefined-team launches arm it; ordinary messages do not. When every live member is idle, the lead receives one inspection tagged with the latest unchecked generation; only the lead's normal settlement after actually accepting it records that generation checked. An inspection is not task completion and never completes a task.

---

## 💡 Coordination Patterns

### Pattern 1: The "Parallel Sprint"
Use this when you have 3-4 independent features to build.
1. Create a team: `team_create({ team_name: "feature-sprint" })`
2. Use `delegate_task` for each specialist and feature.
3. Call `team_wait({ team_name: "feature-sprint" })` after delegation.
4. On return, coordinate from the message and status snapshot. If specialists are still active, wait again; do not duplicate their assigned work.
5. For any follow-up round, use `delegate_task` again; it re-arms the quiescence fallback for the new work.

### Pattern 2: The "Dependency Handoff"
Use this when one teammate unexpectedly needs information or work from another.
1. Send the dependency request with `team_message`.
2. Call `team_wait({ team_name: "feature-sprint" })` only while that dependency is outstanding.
3. Resume when the reply arrives. If `no_active_agents` is returned, report the blocked dependency instead of waiting forever.

### Pattern 3: The "Quality Gate"
Use automated hooks to ensure standards.
1. Define a script at `.pi/team-hooks/task_completed.sh`.
2. When any teammate marks a task as `completed`, the hook runs (e.g., runs `npm test`).
3. If the hook fails, you'll know the work isn't ready.

---

## 🛑 When to Use pi-teams
- **Complex Projects**: Tasks that involve multiple files and logic layers.
- **Research & Execution**: One agent researches while another implements.
- **Parallel Testing**: Running different test suites in parallel.
- **Code Review**: Having one agent write code and another (specialized) agent review it.

## Session Recovery

Resume the original lead Pi conversation to reconnect its inbox and restore missing roster peers' original sessions in tmux panes. Live owners/peers are never force-replaced. Process exit (even manual quit) leaves recovery intent in the roster; explicit member removal or destructive `team_shutdown` removes it. Dissolution deletes roster/tasks/mail, not Pi chat history; manual `/resume` remains possible without automatic team reattachment. Recovery never replays assignments, sends a continuation prompt, or opens a work generation; interrupted sessions remain paused. Missing session mappings/files are reported with data preserved. `/team-resume <team>` is a narrow legacy dead-lead association/current-lead retry, not force takeover. New/fork/clone conversations do not inherit membership. Context recovery is not rollback of background tools or filesystem effects.

## Changing a Teammate Model

`/team-model <teammate> <provider/model> [thinking]` is a lead command. The teammate extension applies `setModel` directly; the teammate model is not asked and no inbox message is sent. An in-flight turn keeps the old model until it ends. Interrupted sessions stay paused. This is not dispatch and does not open a work generation. `delegate_task` reuse still does not change a live model.

## Team Reload

`/team-reload` in the lead session reloads every live member after an on-disk update. Each member reloads itself only when safe: busy runs finish first (never interrupted), and pending inbox delivery, inspection bookkeeping, or an active wait defer it. Interrupted sessions reload and stay paused. `/team-reload status` reports `reloaded`/`pending` from receipts written by the newly loaded code. Reload is not dispatch and never touches tasks, mail, or work generations. Members on a pi-teams version without this feature need one manual `/reload`.

## Closing Panes

`/team-close` closes every live teammate pane while keeping roster, tasks, and inbox. Only the live lead of that team can run it. The lead pane stays. Already-stopped, detached, or dead members are skipped. A pending restore is cancelled so its child cannot attach. Busy runs are killed; sessions stay resumable and are restored on the next original-lead attach or `/team-resume`. `/team-shutdown` does that close and then deletes roster, tasks, and inbox. Chat history survives for manual `/resume` without reattachment. Windows Terminal and Zellij cannot close panes: when a teammate or pending launch still needs closing, both commands refuse without marking members stopped. An already stopped team can still be dissolved.

## ⚠️ Best Practices
- **Isolation**: Give teammates tasks that don't overlap too much to avoid git conflicts.
- **Clear Prompts**: Be specific about the teammate's role and boundaries when spawning.
- **Delegate Then Wait**: `delegate_task` returns immediately. After handing off the current work, call `team_wait` instead of continuing the same work yourself.
- **Coordinate on Return**: Handle messages and blockers, then wait again while teammates remain active.
- **Wait Only for Dependencies**: Teammates should not call `team_wait` just to idle. For a real dependency, send a message first and then wait.
- **Check-ins**: Use `task_list` regularly to see the "big picture" of your team's progress.
