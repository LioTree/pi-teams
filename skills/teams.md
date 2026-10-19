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
7.  **Close only when the user asks**:
    *   `team_close`: Close one teammate pane, or every teammate pane. Membership and the original session stay. Do not call this because work finished.
    *   `team_resume`: Reopen one missing roster session, or every missing one. This is not a new assignment.

## Teammate Instructions

When you are spawned as a teammate:
- Your status bar will show "Teammate: name @ team".
- Your initial assignment and later unread messages are delivered automatically when your Pi session is idle; do not call `team_wait` just to receive routine work.
- Use `team_message` to "team-lead" to report progress or ask questions.
- Complete assigned tasks using `task_complete`.
- Always send a message to "team-lead" when you complete work, get blocked, or need review.
- If you encounter a real dependency on another member, send that member a `team_message` first, then call `team_wait({ team_name })` while the dependency is outstanding.
- Idle inbox delivery runs about once per second. Messages remain unread while you are busy; an active `team_wait` consumes them and resumes you. Interrupted sessions are not auto-resumed. An inbox attempt with unknown host acceptance stays single-flight and unread; it is not a confirmed failure and is not automatically resent.

## Best Practices for Teammates

- **Complete Tasks Semantically**: Use `task_complete` instead of direct status updates whenever possible.
- **Frequent Communication**: Send short summaries of your work back to `team-lead` frequently.
- **Context Matters**: When you finish a task, send a message explaining your results and any new files you created.
- **Independence**: If you get stuck, try to solve it yourself first, but don't hesitate to ask `team-lead` for clarification.
- **Stay available**: When you finish, report the result and remain idle. Do not ask to be removed from the team.

## Best Practices for Team Leads

- **Clear Assignments**: Use `delegate_task` for significant work items.
- **Contextual Prompts**: Provide enough task context in `delegate_task` for the teammate to understand their boundaries.
- **Task List Monitoring**: Regularly call `team_status` to see the status of all work.
- **Delegate Then Wait**: After delegating, call `team_wait({ team_name })` so you pause until a message arrives or no teammate can make progress. Do not perform the teammate's assigned work.
- **Coordinate, Then Wait Again**: When a wait returns, handle reports and blockers only. If teammates are still active, call `team_wait` again.
- **Direct Feedback**: Use `team_message` to provide course corrections or new instructions to teammates.
- **Formal Follow-ups**: Use `delegate_task` for new or follow-up teammate work. It is the dispatch boundary that arms the quiescence fallback. An ordinary `team_message` does not re-arm it, even if it says to continue.
- **Read Status**: Use `team_status` to see the full team roster and current task board.

## Session Recovery

Resume the original Pi conversation, not a new/forked/cloned chat: exact session ID/file identifies the team member. Original lead attachment recovers the inbox and makes one bounded tmux pass to restore missing roster peers with their original sessions/model/thinking, retaining live peers. Recovery is not dispatch and never replays tasks or continuation prompts; interrupted work stays paused.

Quitting or losing a terminal leaves roster intent. Closing a pane does not remove it. Only the user's confirmed `/team-shutdown confirm` deletes the team index; chat history remains for a manual `/resume` without restoring that team. Missing/corrupt/unmapped sessions remain blocked with data preserved. `/team-resume <team> [member]` reopens one missing member or every missing member for the original lead. It cannot force a live owner or guess chat files. Other adapters retain lead inbox recovery but not automatic pane restoration. Restoring context does not roll back background tools or side effects.

## Changing a Teammate Model

`/team-model <teammate> <provider/model> [thinking]` switches a live session without asking that model. Use it when the teammate model has no quota. Do not send the switch as `team_message` or `delegate_task`: those either wait for the model or open a new work generation. An in-flight turn keeps the old model. A paused teammate stays paused.

## Team Reload

`/team-reload` is a user command in the lead session, not a tool. Every live member reloads itself once safe; busy members finish their run first and are not interrupted. It does not dispatch work or change tasks/mail. Do not treat a reload as a reason to re-send assignments.

## Closing Panes

`/team-close <member>` closes that one pane and leaves the lead attached. `/team-close` closes every live teammate pane, then exits the lead Pi back to its shell. The lead pane stays. If a runtime lease changes, or the terminal refuses a close, and a pane stays open, the lead Pi does not exit and confirmed deletion does not remove the team. Roster, tasks, and inbox stay. Reopening the original lead conversation restores every missing roster member, including one closed earlier. `/team-resume <team> [member]` does the same for one member or all missing members and does not replay tasks. `/team-shutdown confirm` is the only deletion: it closes panes and then deletes the team index. The model has no delete-team tool. Windows Terminal and Zellij cannot close panes. When a teammate or pending launch still needs closing, the commands refuse rather than marking members stopped; an already stopped team can still be deleted with `confirm`. Neither command is a work dispatch. Do not treat a closed pane as task completion. An unexpected process stop or a confirmed missing tmux pane sends the lead one inbox notice. A close you requested does not send that notice again.

## Team Quiescence Fallback

Routine per-teammate idle notices are not sent. Instead, a formal dispatch arms one team-wide fallback for that work generation:

- `delegate_task` and a successful `create_predefined_team` worker launch open a generation. Team creation, draft tasks, direct user prompts, model changes, status polling, ordinary `team_message`, progress updates, and acknowledgements do not.
- When every live member is idle with no queued work, unread mail, unknown inbox acceptance, or active dependency wait, pi-teams admits one inspection message tagged with the latest unchecked generation. Multiple dispatches may coalesce into one inspection.
- The inspection lists the generation, members, faults, and tasks. It is an inspection opportunity, not a completion report, and it never marks work complete. Stopped or dead members appear as faults, not success.
- Only a leader run that actually accepted the inspection and then settled normally records its tagged generation as checked. An aborted run releases it without checking it. A checked generation stays checked across later human turns and unrelated settlements.
- Explicit reports (`team_message`, task assignment and completion notifications) are still delivered immediately and are not muted by the fallback.

To re-arm the fallback after checked work, use `delegate_task` for the follow-up; a plain `team_message` will not.

## `team_wait` Result

`team_wait({ team_name, timeout_seconds? })` is available to every member. It returns:

- `outcome: "message"` when the caller receives inbox messages
- `outcome: "no_active_agents"` after repeated checks find no other progress-capable member and no live interrupted peer
- `outcome: "timeout"` only when an explicit positive timeout expires, including time spent paused

The result also includes `messages`, `waitedMs`, `timedOut`, and a member activity snapshot when available. Activity is separate from process liveness and uses `starting`, `queued`, `running`, `waiting`, `idle`, `interrupted`, or `stopped`. A live `interrupted` peer is not progress-capable, even with unread mail, but it keeps an indefinite wait open. Dead or stopped peers do not. Recovery from `interrupted` is a direct user prompt in that session, not a model change or remote resume.
