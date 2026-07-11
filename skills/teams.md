---
description: Coordinate multiple agents working on a project using shared task lists and messaging via tmux or Zellij.
---

# Agent Teams

Coordinate multiple agents working on a project using shared task lists and messaging via **tmux** or **Zellij**.

## Workflow

1.  **Create a team**: Use `team_create(team_name="my-team")`.
2.  **Delegate work**: Prefer `delegate_task` to create a task, assign it, and spawn or reuse the teammate in one call.
3.  **Manage tasks**: 
    *   `task_claim`: Claim unassigned work.
    *   `task_complete`: Mark owned work complete.
    *   `task_list`: List all tasks to monitor progress or find available work.
    *   `task_read`: Get full details of a specific task by ID.
4.  **Communicate**: Use `team_message`.
5.  **Monitor**: Use `team_status` for the full board, or `check_teammate` for one teammate.
6.  **Wait after delegation**: `delegate_task` returns immediately. When you have delegated all current work, call `team_wait({ team_name })` so you do not duplicate a teammate's assignment. Omit `timeout_seconds` for an indefinite wait.
7.  **Cleanup**:
    *   `process_shutdown_approved`: Orderly removal of a teammate after they've finished.
    *   `team_shutdown`: Remove a team and all its associated data.

## Teammate Instructions

When you are spawned as a teammate:
- Your status bar will show "Teammate: name @ team".
- Your initial assignment and later unread messages are delivered automatically when your Pi session is idle; do not call `team_wait` just to receive routine work.
- Use `team_message` to "team-lead" to report progress or ask questions.
- Complete assigned tasks using `task_complete`.
- Always send a message to "team-lead" when you complete work, get blocked, or need review.
- If you encounter a real dependency on another member, send that member a `team_message` first, then call `team_wait({ team_name })` while the dependency is outstanding.
- Idle inbox delivery runs about once per second. Messages remain unread while you are busy; an active `team_wait` consumes them and resumes you.

## Best Practices for Teammates

- **Complete Tasks Semantically**: Use `task_complete` instead of direct status updates whenever possible.
- **Frequent Communication**: Send short summaries of your work back to `team-lead` frequently.
- **Context Matters**: When you finish a task, send a message explaining your results and any new files you created.
- **Independence**: If you get stuck, try to solve it yourself first, but don't hesitate to ask `team-lead` for clarification.
- **Orderly Shutdown**: When you've finished all your work and have no more instructions, notify the lead and wait for shutdown approval.

## Best Practices for Team Leads

- **Clear Assignments**: Use `delegate_task` for significant work items.
- **Contextual Prompts**: Provide enough task context in `delegate_task` for the teammate to understand their boundaries.
- **Task List Monitoring**: Regularly call `team_status` to see the status of all work.
- **Delegate Then Wait**: After delegating, call `team_wait({ team_name })` so you pause until a message arrives or no teammate can make progress. Do not perform the teammate's assigned work.
- **Coordinate, Then Wait Again**: When a wait returns, handle reports and blockers only. If teammates are still active, call `team_wait` again.
- **Direct Feedback**: Use `team_message` to provide course corrections or new instructions to teammates.
- **Read Status**: Use `team_status` to see the full team roster and current task board.

## `team_wait` Result

`team_wait({ team_name, timeout_seconds? })` is available to every member. It returns:

- `outcome: "message"` when the caller receives inbox messages
- `outcome: "no_active_agents"` after repeated checks find no other progress-capable member
- `outcome: "timeout"` only when an explicit positive timeout expires

The result also includes `messages`, `waitedMs`, `timedOut`, and a member activity snapshot when available. Activity is separate from process liveness and uses `starting`, `queued`, `running`, `waiting`, `idle`, or `stopped`.
