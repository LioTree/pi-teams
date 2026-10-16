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
- In default `team` mode, your initial assignment and later unread messages are delivered automatically when your Pi session is idle; do not call `team_wait` just to receive routine work.
- Use `team_message` to "team-lead" to report progress or ask questions.
- Complete assigned tasks using `task_complete`.
- Always send a message to "team-lead" when you complete work, get blocked, or need review.
- If you encounter a real dependency on another member, send that member a `team_message` first, then call `team_wait({ team_name })` while the dependency is outstanding.
- Idle inbox delivery runs about once per second. Messages remain unread while you are busy; an active `team_wait` consumes them and resumes you. Interrupted sessions are not auto-resumed. An inbox attempt with unknown host acceptance stays single-flight and unread; it is not a confirmed failure and is not automatically resent.

## Local Human Takeover

Only the human in a teammate pane can switch control with `/team-mode user`, `/team-mode team`, or `/team-mode flush`; `/team-mode` shows current mode and pending counts. These are local harness commands, not team tools or a remote resume API. They also work during a busy run without aborting or starting a model call.

`user` is real multi-turn work in the original session, not a fork or an interrupted disguise. Continue human prompts, edits, tools, and model changes. The harness holds ordinary idle notices, leader-directed `team_message`, task-completion notices, and only the leader recipient of broadcasts. Do not claim held messages were delivered. Peer dependencies still deliver. Idle inbox auto-start pauses; an already-active explicit dependency `team_wait` can still consume mail. Accepted metadata-only ACK is not blocked merely by user control, and unknown attempts are never reset or resent by a mode switch.

`flush` explicitly releases held content while keeping user mode; `team` releases and hands back. Neither means task complete or resumes an interrupted turn. Release includes latest known task/activity state and original reports, with redundant idle snapshots coalesced. An empty release says no completion report was provided. Errors retain pending intent; an append may already have committed, so retry the local release, not the completed task.

The UI and `team_status`/`check_teammate` show ownership separately. A live user-controlled idle peer suspends `no_active_agents` but is not progress-capable just because it is human-owned; messages, explicit timeout, abort, death, and stop still win. Do not silently delegate/reuse/replace it. Ordinary Pi restart preserves ownership and reports. Intentional removal ends ownership but retains pending reports for an explicitly flushed replacement; team deletion removes them. Dedupe requires retained control records/inbox history, not exactly-once model execution. See `docs/reference.md` for details.

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
- `outcome: "no_active_agents"` after repeated checks find no other progress-capable member and no live interrupted or user-controlled peer
- `outcome: "timeout"` only when an explicit positive timeout expires, including time spent paused

The result also includes `messages`, `waitedMs`, `timedOut`, and a member activity snapshot when available. Activity is separate from process liveness and uses `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, or `stopped`. A live `interrupted` peer is not progress-capable, even with unread mail, but it keeps an indefinite wait open. Dead or stopped peers do not. Recovery from `interrupted` is a direct user prompt in that session, not a model change or remote resume.
