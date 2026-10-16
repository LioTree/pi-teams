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

Create your first team:

> **You:** "Create a team named 'my-team'"

Set a default model for all teammates:

> **You:** "Create a team named 'Research' and use 'gpt-4o' for everyone"

---

## Common Workflows

### 1. Code Review Team

> **You:** "Create a team named 'code-review' using 'gpt-4o'"
> **You:** "Spawn a teammate named 'security-reviewer' to check for vulnerabilities"
> **You:** "Spawn a teammate named 'performance-reviewer' using 'haiku' to check for optimization opportunities"
> **You:** "Create a task for security-reviewer: 'Review the auth module for SQL injection risks' and set it to in_progress"
> **You:** "Create a task for performance-reviewer: 'Analyze the database queries for N+1 issues' and set it to in_progress"

### 2. Long-Running Security Audit

> **You:** "Create a team named 'security-audit'"
> **You:** "Delegate authentication review to auth-auditor and session review to session-auditor"
> **You:** "Wait for the security-audit team"

Delegation returns immediately, so the final instruction should call `team_wait({ team_name: "security-audit" })`. With no timeout, the lead can remain blocked for as long as a live teammate is running. The wait returns when a message arrives or when no other member can make progress.

When it returns, the lead should process reports and coordinate follow-up work. It should not independently repeat the delegated audit. If teammates are still active, call `team_wait` again.

### 3. Testing with Automated Hooks

Create a hook script at `.pi/team-hooks/task_completed.sh`:

```bash
#!/bin/bash
# This script runs automatically when any task is completed

echo "Running post-task checks..."
npm test
if [ $? -ne 0 ]; then
  echo "Tests failed! Please fix before marking task complete."
  exit 1
fi

npm run lint
echo "All checks passed!"
```

> **You:** "Create a team named 'test-team'"
> **You:** "Spawn a teammate named 'qa-bot' to write tests"
> **You:** "Create a task for qa-bot: 'Write unit tests for the payment module' and set it to in_progress"

When qa-bot marks the task as completed, the hook automatically runs tests and linting.

### 4. Coordinated Migration

> **You:** "Create a team named 'migration-team'"
> **You:** "Spawn a teammate named 'db-migrator' to handle database changes"
> **You:** "Spawn a teammate named 'api-updater' using 'gpt-4o' to update API endpoints"
> **You:** "Spawn a teammate named 'test-writer' to write tests for the migration"
> **You:** "Create a task for db-migrator: 'Add new columns to the users table' and set it to in_progress"

After db-migrator completes, broadcast the schema change:

> **You:** "Broadcast to the team: 'New columns added to users table: phone, email_verified. Please update your code accordingly.'"

If api-updater unexpectedly needs the exact schema before it can continue, it should send db-migrator a `team_message` and then call `team_wait`. It should not wait merely because it has no current work; idle inbox delivery is automatic.

### 5. Mixed-Speed Team

Use different models for cost optimization:

> **You:** "Create a team named 'mixed-speed' using 'gpt-4o'"
> **You:** "Spawn a teammate named 'architect' using 'gpt-4o' with 'xhigh' thinking level for design decisions"
> **You:** "Spawn a teammate named 'implementer' using 'haiku' with 'low' thinking level for quick coding"
> **You:** "Spawn a teammate named 'reviewer' using 'gpt-4o' with 'medium' thinking level for code reviews"

Now you have expensive reasoning for design and reviews, but fast/cheap implementation.

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
2. Call `team_wait({ team_name: "my-team" })` while that dependency is outstanding.
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

The user aborted that session. Its tasks stay owned, its inbox stays unread, and pi-teams will not inject those messages or resume the run. A lead's indefinite `team_wait` also stays open while that process is alive. Resume it by typing a new prompt in that session. Selecting a model does not start execution, and there is no remote resume command. If the process has actually stopped or died, it no longer holds the wait. A direct prompt does not resend an inbox attempt whose host acceptance is still unknown; that attempt stays unread until Pi confirms it or a person starts a new process.

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
  team_name: "my-team",
  to: "backend-bot",
  content: "Please confirm the final /api/users response shape."
})
team_wait({ team_name: "my-team" })
```

Ordinary idle teammates do not call `team_wait`; pi-teams delivers their unread messages automatically when their session is idle. Interrupted teammates are paused until a direct user prompt in that session; mail does not resume them.

---

## Cleanup

To remove all team data:

```bash
# Shut down team first
> "Shut down the team named 'my-team'"

# Then delete data directory
rm -rf ~/.pi/teams/my-team/
rm -rf ~/.pi/tasks/my-team/
rm -rf ~/.pi/messages/my-team/
```

Or use the delete command:
> **You:** "Delete the team named 'my-team'"
