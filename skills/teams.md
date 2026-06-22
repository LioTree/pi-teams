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
    *   `task_update`: Low-level direct status or owner changes. Completion follows `task_complete` rules.
4.  **Communicate**: Prefer `team_message`; use `read_inbox` for low-level inbox inspection.
5.  **Monitor**: Use `team_status` for the full board, or `check_teammate` for one teammate.
6.  **Wait after delegation**: When you have delegated all current work, use `team_wait` to pause for a message, plan, completion, or all tasks done.
7.  **Cleanup**:
    *   `process_shutdown_approved`: Orderly removal of a teammate after they've finished.
    *   `team_shutdown`: Remove a team and all its associated data.

## Teammate Instructions

When you are spawned as a teammate:
- Your status bar will show "Teammate: name @ team".
- You will automatically start by calling `read_inbox` to get your initial instructions.
- Regularly check `read_inbox` for updates from the lead.
- Use `team_message` to "team-lead" to report progress or ask questions.
- Complete assigned tasks using `task_complete`.
- Always send a message to "team-lead" when you complete work, submit a plan, get blocked, or need review.
- If you are idle for more than 30 seconds, you will automatically check your inbox for new messages.

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
- **Delegate Then Wait**: After delegating and having no independent work, call `team_wait` so you pause until the teammate reports back.
- **Direct Feedback**: Use `team_message` to provide course corrections or new instructions to teammates.
- **Read Status**: Use `team_status` to see the full team roster and current task board.
