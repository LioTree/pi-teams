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
- **Inbox Delivery**: In default `team` mode, about once per second an idle teammate receives the actual contents of unread inbox messages. Busy agents leave messages unread; an agent in `team_wait` consumes them through the active wait. An `interrupted` session is not polled and does not auto-resume. Unknown host acceptance stays single-flight and unread in that process; it is not automatically resent and is not a confirmed failure.
- **Blocking Waits**: Any member can call `team_wait({ team_name, timeout_seconds? })`. Omit the timeout for a long-lived barrier; it returns on a message, timeout, or when no other member can make progress. A live `interrupted` peer is not progress-capable, but it keeps an indefinite wait open until it resumes, stops, or dies.
- **Human Control**: Local `/team-mode user` takes continuous control of the original teammate session; real prompts/tools/model changes still work. The harness holds that member's idle notices, explicit leader reports, task-completion notifications, and broadcast's leader recipient. Other peers still receive messages. `/team-mode flush` explicitly releases reports without leaving user mode; `/team-mode team` releases and hands back, not marks work complete. Commands are harness-only and do not abort/resume a busy or interrupted run. Mode is visible separately in UI and read-tool snapshots.
- **Control Boundaries**: User mode pauses idle inbox auto-start, not an already-active explicit dependency `team_wait` or accepted metadata-only ACK. Previously handed-to-host/unknown requests are not recalled or resent. A live user-owned peer holds `no_active_agents` without pretending idle means progress; other messages, explicit timeout, abort, death, and stop still win. Do not delegate/reuse/replace a user-controlled name until local handback or intentional removal.
- **Durable Handoff**: Retain actual held content and coalesce only idle snapshots; explicit release uses a persisted batch ID so retry does not duplicate retained inbox history. No report means no completion report. Ordinary restart retains mode/reports; intentional removal ends ownership but keeps pending reports for an explicitly flushed replacement, while team deletion removes them. See `docs/reference.md` for failure and persistence limits.
- **Activity Tracking**: Members report `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, or `stopped`, independently from process liveness. `interrupted` means the user aborted that session. Recovery is a direct user prompt there, not a model change or remote resume.

---

## 💡 Coordination Patterns

### Pattern 1: The "Parallel Sprint"
Use this when you have 3-4 independent features to build.
1. Create a team: `team_create({ team_name: "feature-sprint" })`
2. Use `delegate_task` for each specialist and feature.
3. Call `team_wait({ team_name: "feature-sprint" })` after delegation.
4. On return, coordinate from the message and status snapshot. If specialists are still active, wait again; do not duplicate their assigned work.

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

## ⚠️ Best Practices
- **Isolation**: Give teammates tasks that don't overlap too much to avoid git conflicts.
- **Clear Prompts**: Be specific about the teammate's role and boundaries when spawning.
- **Delegate Then Wait**: `delegate_task` returns immediately. After handing off the current work, call `team_wait` instead of continuing the same work yourself.
- **Coordinate on Return**: Handle messages and blockers, then wait again while teammates remain active.
- **Wait Only for Dependencies**: Teammates should not call `team_wait` just to idle. For a real dependency, send a message first and then wait.
- **Check-ins**: Use `task_list` regularly to see the "big picture" of your team's progress.
