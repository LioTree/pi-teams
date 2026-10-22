# pi-teams Usage Guide

This guide provides detailed examples, patterns, and best practices for using pi-teams.

## Table of Contents

- [Getting Started](#getting-started)
- [Common Workflows](#common-workflows)
- [Hook System](#hook-system)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### Basic Team Setup

First, make sure you're inside a tmux session, Zellij session, or iTerm2:

```bash
tmux  # or zellij, or just use iTerm2
```

Then start pi:

```bash
pi
```

Delegate directly from your main conversation:

> **You:** "Delegate authentication review to security-reviewer and query review to performance-reviewer, then wait for their reports."

No explicit team creation, naming, or selection is needed. The first delegation establishes this conversation's internal collaboration. Tools omit `team_name`; two main conversations in the same directory remain isolated. Existing saved records attach through their exact original Pi sessions.

Configure `teammateDefaultProvider`, `teammateDefaultModel`, and `teammateDefaultThinkingLevel` in the actual Pi agent directory's `settings.json` for defaults. Explicit model/thinking overrides are used only when you request them. Reusing a member retains its conversation and current model settings.

---

## Common Workflows

### Independent reviews

> **You:** "Delegate security review to security-reviewer and performance review to performance-reviewer. Keep their findings independent."

After delegation, the lead calls `team_wait({})` instead of duplicating assigned work. Without a timeout it waits for a report or until no other member can make progress. A live interrupted peer keeps an indefinite wait open; resume that peer with a direct prompt in its own conversation. Process reports, then wait again if work remains active.

### Testing with automated hooks

Create `.pi/team-hooks/task_completed.sh` to run project tests. A failing hook prevents completion. Then:

> **You:** "Delegate payment-module unit tests to qa-bot."

### Dependency handoff

> **You:** "Delegate schema migration to db-migrator and API updates to api-updater."

If api-updater needs the final schema, it messages db-migrator and waits only while that dependency is outstanding. Idle inbox delivery is automatic; teammates do not wait merely to become idle.

### Reusable roles

> **You:** "Start the plan-build template in the current conversation."

Use `create_predefined_team({ predefined_team: "plan-build", cwd: "/path/to/project" })`. No team name is required. Templates remain reusable across projects. Save current teammates with `save_team_as_template({ template_name: "review-workflow" })`.

---

## Hook System

### Overview

Hooks are shell scripts that run automatically at specific events. Currently supported:

- **`task_completed.sh`** - Runs when any task's status changes to `completed`

### Hook Location

Hooks should be placed in `.pi/team-hooks/` in your project directory:

```
your-project/
├── .pi/
│   └── team-hooks/
│       └── task_completed.sh
```

### Hook Payload

The hook receives the task data as a JSON string as the first argument:

```bash
#!/bin/bash
TASK_DATA="$1"
echo "Task completed: $TASK_DATA"
```

Example payload:
```json
{
  "id": "task_123",
  "subject": "Fix login bug",
  "description": "Users can't login with special characters",
  "status": "completed",
  "owner": "fixer-bot"
}
```

### Example Hooks

#### Test on Completion

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')

echo "Running tests after task: $SUBJECT"
npm test
```

#### Notify Slack

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')
OWNER=$(echo "$TASK_DATA" | jq -r '.owner')

curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"Task '$SUBJECT' completed by $OWNER\"}" \
  "$SLACK_WEBHOOK_URL"
```

#### Conditional Checks

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')

# Only run full test suite for production-related tasks
if [[ "$SUBJECT" == *"production"* ]] || [[ "$SUBJECT" == *"deploy"* ]]; then
  npm run test:ci
else
  npm test
fi
```

---

## Best Practices

### 1. Use Thinking Levels Wisely

- **`off`** - Simple tasks: formatting, moving code, renaming
- **`minimal`** - Quick decisions: small refactors, straightforward bugfixes
- **`low`** - Standard work: typical feature implementation, tests
- **`medium`** - Complex work: architecture decisions, tricky bugs
- **`high`** - Critical work: security reviews, major refactors, design specs
- **`xhigh`** - Deep reasoning: architecture audits, thorny debugging, high-stakes review work
- **`max`** - Maximum reasoning depth supported by pi: hardest design/debug problems only

### 2. Team Composition

Balanced teams typically include:
- **1-2 high-thinking, high-model** agents for architecture and reviews
- **Use `xhigh`/`max` sparingly** for the one teammate doing the hardest reasoning-heavy work
- **2-3 low-thinking, fast-model** agents for implementation
- **1 medium-thinking** agent for coordination

Example:
```bash
# Design/Review duo (expensive but thorough)
spawn "architect" using "gpt-4o" with "max" thinking
spawn "reviewer" using "gpt-4o" with "medium" thinking

# Implementation trio (fast and cheap)
spawn "backend-dev" using "haiku" with "low" thinking
spawn "frontend-dev" using "haiku" with "low" thinking
spawn "test-writer" using "haiku" with "off" thinking
```

### 3. Make Dependencies Explicit

Avoid splitting work with known blocking dependencies when independent tasks are available. If an unexpected dependency appears:

1. Send the needed request to the responsible teammate with `team_message`.
2. Call `team_wait({})` while that dependency is outstanding.
3. Resume on the reply. Treat `no_active_agents` as a blocker to report or reassign, not a reason to spin forever.

This works for teammate-to-teammate dependencies as well as lead-to-teammate delegation.

### 4. Broadcast for Coordination

Use broadcasts when:
- API endpoints change
- Database schemas change
- Deployment happens
- Team priorities shift

### 5. Clear Task Descriptions

Good task:
```
"Add password strength validation to the signup form. 
Requirements: minimum 8 chars, at least one number and symbol.
Use the zxcvbn library for strength calculation."
```

Bad task:
```
"Fix signup form"
```

### 6. Delegate Then Wait

`delegate_task` returns immediately. When you assign all current work to teammates, wait for a report instead of continuing the same task as the lead.

> **You:** "Wait for my inbox until a teammate reports back."

With no `timeout_seconds`, `team_wait` is an indefinite barrier: long security reviews are not cut off by a default deadline. It returns with `outcome: "message"`, `"no_active_agents"`, or `"timeout"`. A live interrupted teammate is not making progress, but that pause does not end the wait. Use the result for review, coordination, and follow-up decisions; if teammates remain active or interrupted, wait again.

### 7. Check Progress Regularly

> **You:** "List all tasks"
> **You:** "Check my inbox for messages"
> **You:** "How is the team doing?"

This helps you catch blockers early and provide feedback.

---

## Troubleshooting

### Teammate Not Responding

**Problem**: A teammate is idle but not picking up messages.

**Solution**:
1. Check if they're still running:
   > **You:** "Check on teammate named 'security-bot'"
2. Check their inbox:
   > **You:** "Read security-bot's inbox"
3. Force kill and respawn if needed:
   > **You:** "Force kill security-bot and respawn them"

**Problem**: A teammate shows activity `interrupted`.

The user aborted that session. Its tasks stay owned, its inbox stays unread, and pi-teams will not inject those messages or resume the run. A lead's indefinite `team_wait` also stays open while that process is alive. Resume it by typing a new prompt in that session. Selecting a model does not start execution, and there is no remote resume command. If the process has actually stopped or died, it no longer holds the wait. A direct prompt does not resend an inbox attempt whose host acceptance is still unknown. Persisted unknown-acceptance evidence remains single-flight across recovery, too; no restart is an acceptance receipt.

### Recovering after Pi or terminal exit

Resume the original lead conversation. Exact Pi session identity reconnects its inbox and restores missing roster peers' original sessions in tmux panes, only when their saved window intent is open; individually closed panes stay hidden and live peers are retained. Manual quit, Ctrl+D, terminal loss, and pane close do not remove roster intent. Only `/team-shutdown confirm` deletes the team index. That deletion removes roster/tasks/inbox, not Pi chat history: original conversations remain available for manual `/resume` without automatic team reattachment. Recovery never replays assignments/continuation prompts or resumes interrupted work; restoring context does not roll back background tools or filesystem effects.

Missing/corrupt/unmapped sessions are reported without deletion or fresh replacement. `/team-resume [member]` explicitly reopens original sessions, including hidden members. For an unmapped legacy lead whose old process is gone, `/team-resume <team>` explicitly associates this saved conversation. It never forces a live owner or guesses recent chat files. Automatic pane restoration is tmux-only; other adapters can recover the lead inbox. See [design and migration limits](design/team-session-recovery.md).

### Changing a teammate's model while it is live

`/team-model worker xai/grok-4.7 xhigh` switches that session from the lead. The worker's extension applies the host model change itself, so it works when the worker's current model has no quota and cannot answer. The turn already running keeps the old model; nothing is aborted. A paused worker stays paused. Omit the thinking level to leave it unchanged. `delegate_task` still does not change a live member's model.

### Reloading every teammate after an update

Run `/team-reload` in the lead session. Every live member runs Pi's `/reload` on its own once it is safe: busy runs finish first, and pending inbox delivery, inspection bookkeeping, or an active `team_wait` defer it. Interrupted sessions reload and remain paused. A reloading member is never treated as stopped, so the lead does not reopen its pane; the lead's own reload also skips pane restoration (run `/team-resume [member]` to retry it). If a reload fails after starting, the member stays marked `reloading` in `/team-reload status` (shown as `pending (reloading)`) and in `team_status`/`check_teammate` with a frozen `reloadingSince` timestamp: fix the code on disk and reload that pane again to recover. Check progress with `/team-reload status`; a member is `reloaded` only when its newly loaded code has written a receipt. Install the update on disk first (`pi update`/`pi install`). Sessions running an older pi-teams without this command must be reloaded manually once.

### Closing every teammate pane

`/team-close worker` closes that one pane and leaves the lead attached. `/team-close` closes every live teammate pane, then exits the lead Pi back to its shell. If a teammate's runtime lease changes during the close, or the terminal refuses the close, that pane stays open and the lead Pi does not exit. The lead pane, team, tasks, and inbox stay. Only the Pi session that currently owns that team's lead lease can run it. Members that are already stopped, detached, or dead are listed as `not running` and are not killed again. A teammate pane that was launched for recovery but has not registered is closed, and that launch can no longer attach. A busy teammate is stopped mid-run; its Pi session remains resumable. Resume the original lead conversation to restore only members with open window intent. An individually closed member stays hidden. `/team-resume <member>` explicitly opens that original conversation; `/team-resume` explicitly opens all missing members, including hidden ones. New delegation to an existing closed member also opens its original session. Ordinary mail, status, model changes, and reloads do not open hidden panes.

Whole `/team-close` preserves prior window intent and takes a final tmux snapshot for manual closes not yet observed by the poller. A closed + B open → whole close → recover lead → only B opens. Confirmed tmux pane loss while the lead lives is treated as keep-closed (manual closure and crash cannot reliably be distinguished). Offline losses after lead exit do not change saved intent.

`/team-shutdown confirm` performs that same close, then deletes roster, tasks, and inbox only when every pane that needed closing actually closed. Without `confirm` the command refuses before closing anyone. Conversation history stays in Pi's normal session storage for a manual `/resume`, without rejoining the team. The leader can call `team_close` and `team_resume` only when you ask; it has no tool that deletes the team because work finished. On Windows Terminal and Zellij the close is not implemented. If a teammate or a pending launch still needs closing, including one that appears after the first check, the command reports that and does not mark anyone stopped or delete the team. An already stopped team can still be deleted with `confirm`. If a process stops or a tmux pane disappears on its own, the lead receives one inbox notice and does not restart that member.

### tmux Pane Issues

**Problem**: tmux panes don't close when killing teammates.

**Solution**: Make sure you started pi inside a tmux session. If you started pi outside tmux, it won't work properly.

```bash
# Correct way
tmux
pi

# Incorrect way
pi  # Then try to use tmux commands
```

### Hook Not Running

**Problem**: Your task_completed.sh script isn't executing.

**Checklist**:
1. File exists at `.pi/team-hooks/task_completed.sh`
2. File is executable: `chmod +x .pi/team-hooks/task_completed.sh`
3. Shebang line is present: `#!/bin/bash`
4. Test manually: `.pi/team-hooks/task_completed.sh '{"test":"data"}'`

### Model Errors

**Problem**: "Model not found" or similar errors.

**Solution**: Check the model name is correct and available in your pi config. Some model names vary between providers:

- `gpt-4o` - OpenAI
- `haiku` - Anthropic (usually `claude-3-5-haiku`)
- `glm-4.7` - Zhipu AI

Check your pi config for available models.

### Data Location

All team data is stored in:
- `~/.pi/teams/<team-name>/` - Team configuration, member list
- `~/.pi/tasks/<team-name>/` - Task files
- `~/.pi/messages/<team-name>/` - Message history

You can manually inspect these JSON files to debug issues.

### iTerm2 Not Working

**Problem**: iTerm2 splits aren't appearing.

**Requirements**:
1. You must be on macOS
2. iTerm2 must be your terminal
3. You must NOT be inside tmux or Zellij (iTerm2 detection only works as a fallback)

**Alternative**: Use tmux or Zellij for more reliable pane management.

---

## Inter-Agent Communication

Teammates can message each other without your intervention:

```
Frontend Bot → Backend Bot: "What's the response format for /api/users?"
Backend Bot → Frontend Bot: "Returns {id, name, email, created_at}"
```

This enables autonomous coordination. You can see these messages by:
> **You:** "Read backend-bot's inbox"

When one teammate cannot continue without a reply, use an explicit request followed by a wait:

```javascript
team_message({
  to: "backend-bot",
  content: "Please confirm the final /api/users response shape."
})
team_wait({})
```

Ordinary idle teammates do not call `team_wait`; pi-teams delivers their unread messages automatically when their session is idle. Interrupted teammates are paused until a direct user prompt in that session; mail does not resume them.

---

## Cleanup

To remove all team data:

```bash
# Shut down team first
> "Dissolve this conversation's collaboration with /team-shutdown confirm"

# Then delete data directory
rm -rf ~/.pi/teams/my-team/
rm -rf ~/.pi/tasks/my-team/
rm -rf ~/.pi/messages/my-team/
```

Or use the delete command:
> **You:** "Delete this conversation's collaboration data with /team-shutdown confirm"
