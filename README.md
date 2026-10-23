# pi-teams 🚀

**pi-teams** turns your single Pi agent into a coordinated software engineering team. It allows you to spawn multiple "Teammate" agents in separate terminal panes that work autonomously, communicate with each other, and manage a shared task board—all mediated through tmux, Zellij, iTerm2, WezTerm, or Windows Terminal.

### 🖥️ pi-teams in Action

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="iTerm2.png"><img src="iTerm2.png" width="300" alt="pi-teams in iTerm2"></a> | <a href="tmux.png"><img src="tmux.png" width="300" alt="pi-teams in tmux"></a> | <a href="zellij.png"><img src="zellij.png" width="300" alt="pi-teams in Zellij"></a> |

*Also works with **WezTerm** and **Windows Terminal** (cross-platform support)*

## 🛠 Installation

Requires Pi `>=1.1.0 <2` and Node.js `22.19.0` or newer. Pi `1.1.0` provides the aborted-settlement signal used to keep interrupted teammates paused without waking the lead, as well as the settled-agent lifecycle event and sequential custom-tool execution used by the coordination barrier.

Install this fork’s pinned GitHub release:

```bash
pi install git:github.com/LioTree/pi-teams@v0.11.0
```

This is the [LioTree/pi-teams](https://github.com/LioTree/pi-teams) fork. The `npm:pi-teams` package belongs to upstream and does not install this fork’s changes. Use only one pi-teams source at a time; remove an earlier local or upstream source before installing this one. Git tags are pinned: to upgrade an older tagged installation, install the new tag explicitly.

### Upgrading to 0.11.0

No explicit team creation or selection is needed: delegate directly from the current main conversation. Existing saved collaborations retain their original session bindings. Older member records without window-intent metadata default to open; the upgrade cannot retrospectively identify panes you manually closed before their intent was recorded. Automatic pane restoration remains tmux-only.

## Extension Compatibility

On Pi versions with structured system prompts, pi-teams refreshes its own `pi_teams` section on every new run. It does not replace the complete system prompt, so other extensions' sections, including magic-context guidance, remain intact regardless of whether Teams or magic-context loads first. The legacy prompt-return fallback remains for API compatibility, also on every run, but Pi versions older than `1.1.0` are not supported.

Pi-provided libraries are peer dependencies rather than bundled runtime dependencies, so extensions use the host's library instances.

### Using magic-context

Teammates are independent Pi processes and can load magic-context normally. However, magic-context's internal historian/dreamer processes can inherit the teammate's environment. Keep those internal processes from discovering the Teams extension by merging this into the **user-level** `~/.config/cortexkit/magic-context.jsonc` configuration:

```json
{
  "pi": {
    "subagent_extensions": []
  }
}
```

Preserve your other magic-context settings. This setting limits extension discovery in magic-context's own internal subprocesses; it does not disable magic-context in working teammates. Restart affected Pi processes after changing it.

Prompt composition and tool registration are tested with Pi `1.1.0` and magic-context `0.48.0`. This is not a certification of long-running concurrent historian/dreamer workloads.

## 🚀 Quick Start

```bash
# 1. Open Pi inside tmux, Zellij, or iTerm2. No team setup is needed.
# 2. Delegate tasks directly from the current main conversation
"Delegate a task to security-bot: 'Audit auth endpoints'"
"Delegate a task to frontend-dev using haiku: 'Review the dashboard UI'"

# 3. Wait for reports without duplicating delegated work
"Wait until a teammate reports back"
```

## 🌟 What can it do?

### Core Features
- **Spawn Specialists**: Create agents like "Security Expert" or "Frontend Pro" to handle sub-tasks in parallel.
- **Shared Task Board**: Keep everyone on the same page with a persistent list of tasks and their status.
- **Agent Messaging**: Agents can send direct messages to each other and to you (the Team Lead) to report progress.
- **Autonomous Work**: Teammates automatically receive the actual contents of unread inbox messages whenever their Pi session is idle. An interrupted session does not auto-resume; recovery from interruption is a direct user prompt in that session. An attempt whose acceptance is still unknown is not resent in that process.
- **Delegate and Wait**: Any team member can block with `team_wait` while another member is making progress. With no timeout, the wait is indefinite.
- **Beautiful UI**: Optimized vertical splits in `tmux` with clear labels so you always know who is doing what.

### Advanced Features
- **Predefined Teams**: Define team templates in `teams.yaml` and spawn entire teams with a single command.
- **Save Teams as Templates**: Convert any runtime team into a reusable template with a single command.
- **Isolated OS Windows**: Launch teammates in true separate OS windows instead of panes.
- **Persistent Window Titles**: Windows are automatically titled `[team-name]: [agent-name]` for easy identification in your window manager.
- **Broadcast Messaging**: Send a message to the entire team at once for global coordination and announcements.
- **Quality Gate Hooks**: Automated shell scripts run when tasks are completed (e.g., to run tests or linting).
- **Thinking Level Control**: Set per-teammate thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to balance speed vs. reasoning depth.
- **Quiescence Fallback**: One team-wide inspection per formally dispatched work generation when everyone is idle, replacing routine per-teammate idle notices. Use `delegate_task` for follow-up work to re-arm it.

## 💬 Key Examples

### 1. Start from Your Main Conversation
> **You:** "Delegate a codebase audit to audit-bot."

The first delegation establishes collaboration for this exact Pi conversation. You do not create, name, or select a team. Another main conversation in the same directory has separate teammates, tasks, and messages. Existing saved collaborations still attach through their original Pi sessions.

Configure teammate defaults below, or explicitly request a model for an individual delegation or template launch.

**Configure teammate defaults in the Pi agent settings file (no TASK/prompt needed):**

By default this is `~/.pi/agent/settings.json`. When `PI_CODING_AGENT_DIR` is set, pi-teams reads `settings.json` from that directory instead.

```json
{
  "defaultProvider": "grok-oauth",
  "defaultModel": "grok-4.5",
  "defaultThinkingLevel": "high",
  "teammateDefaultProvider": "opencode-go",
  "teammateDefaultModel": "deepseek-v4-flash",
  "teammateDefaultThinkingLevel": "max"
}
```
- Leader still uses `defaultProvider` / `defaultModel` / `defaultThinkingLevel`.
- Teammate model priority is: explicit tool/agent model → team `default_model` → `teammateDefaultModel` → Pi's leader defaults (by launching bare `pi`).
- Teammate thinking priority is independent of the team model: explicit tool/agent thinking → `teammateDefaultThinkingLevel` → Pi's leader defaults.
- `teammateDefaultModel` may be a full `provider/model` string; `teammateDefaultProvider` is only used when the model id has no `/`.

**Delegate in "Separate Windows" mode:**
> **You:** "Delegate the review to reviewer in a separate window."
*(Supported in iTerm2 and WezTerm only)*

### 2. Delegate Work with Custom Settings
> **You:** "Delegate a task to security-bot in the current folder: scan for hardcoded API keys."

**Delegate to a teammate in a separate window:**
> **You:** "Delegate research to researcher in a separate window."

**Move the Team Lead to a separate window:**
> **You:** "Open the team lead in its own window."
*(Requires separate_windows mode enabled or iTerm2/WezTerm. This is a handoff: the original lead session exits so only the new window owns the lead inbox.)*

**Use a different model:**
> **You:** "Delegate benchmarks to speed-bot using haiku."

**Customize model and thinking level:**
> **You:** "Delegate architecture review to architect-bot using gpt-4o with high thinking level."

**Smart Model Resolution:**
When you specify a model name without a provider (e.g., `gemini-2.5-flash`), pi-teams automatically:
- Queries available models from `pi --list-models`
- Prioritizes **OAuth/subscription providers** (cheaper/free) over API-key providers:
  - `google-gemini-cli` (OAuth) is preferred over `google` (API key)
  - `github-copilot`, `kimi-sub` are preferred over their API-key equivalents
- Falls back to API-key providers if OAuth providers aren't available
- Constructs the correct `--model provider/model:thinking` command

> **Example:** Specifying `gemini-2.5-flash` will automatically use `google-gemini-cli/gemini-2.5-flash` if available, saving API costs.

### 3. Delegate and Wait
> **You:** "Delegate to security-bot: check the .env.example file for sensitive defaults, then wait for the team."

`delegate_task` returns immediately after assigning the work. The lead should then call:

```javascript
team_wait({})
```

Without `timeout_seconds`, this blocks indefinitely until an inbox message arrives or no other member can make progress. It returns an `outcome` of `message`, `no_active_agents`, or `timeout`. A live interrupted teammate cannot make progress and will not pick up mail on its own, but it keeps this indefinite wait open; do not treat that pause as `no_active_agents`. An explicit timeout still includes the paused time. After it returns, coordinate based on the result instead of performing the teammate's delegated work; if teammates are still active, wait again. Resume a paused teammate with a direct user prompt in that session. Changing its model does not resume it, and there is no remote resume API.

Teammates can use the same barrier for a real dependency. First send the request, then wait:

```javascript
team_message({
  to: "api-owner",
  content: "Please send me the finalized response schema."
})
team_wait({})
```

Teammates do not call `team_wait` merely because they are idle; idle inbox delivery is automatic.

Routine per-teammate idle notices are replaced by one team-wide inspection per formal dispatch generation. `delegate_task` (new work, follow-up, or re-dispatch) and a successful predefined-team launch arm it; ordinary `team_message` does not, even when it says to continue. When the whole team is quiescent with the generation unchecked, the lead receives an inspection naming the generation, member states, faults, and tasks. The inspection is an opportunity to inspect artifacts and finish or formally dispatch more work; it is never a claim that the work is complete and never marks a task complete. Explicit reports and task notifications are still delivered immediately.

### 4. Broadcast to Team
> **You:** "Broadcast to the entire team: 'The API endpoint has changed to /v2. Please update your work accordingly.'"

### 5. Shut Down Team
> **You:** "We're done. Shut down the team and close the panes."

**Automatic Cleanup:**
When you shut down a team, pi-teams automatically cleans up orphaned agent session folders from `~/.pi/agent/teams/` that are older than 1 hour. This prevents accumulation of stale session data over time.

**Manual Cleanup:**
If you need to clean up agent sessions without shutting down a team, or want to use a different age threshold:
> **You:** "Clean up agent session folders older than 24 hours."

---

## Recovering a Team

Resume the **original lead Pi conversation**. Its exact session ID/file reattaches the inbox; on tmux, missing roster teammates whose saved window intent is open reopen their **original sessions** in new panes. Live peers are kept. Model/thinking history, tasks, and unread mail are preserved; recovery does not replay assignments, send a continuation prompt, or open a new work generation. Interrupted sessions stay paused until direct user input.

Quitting Pi, losing a terminal, or closing a pane does not remove membership. Reopening the original lead conversation restores only teammates whose saved window intent is open. Individually closed teammates stay closed. Whole `/team-close` preserves each teammate's prior intent. `/team-shutdown confirm` is the only deletion of roster/tasks/mail; chats remain available for manual `/resume` without automatic team reattachment. Restoring context does not roll back background tools or filesystem effects.

Missing/corrupt session files and unmapped legacy members are reported without deletion or fresh-chat substitution. For a legacy lead with no saved binding and **no live old owner**, explicitly associate the current saved conversation with `/team-resume <team>`; a current lead may also use it for a bounded pane retry. New/forked/cloned conversations never inherit team ownership automatically. Automatic pane restoration currently requires tmux; other adapters can still recover the lead inbox.

See [session recovery design and limits](docs/design/team-session-recovery.md).

## Changing a live teammate's model

Ask the leader to switch a teammate's model: it calls `team_set_model` with the target and model, then queries the same tool without `model` to confirm `applied` (a submitted request is only `pending`). The teammate model does not need to respond.

For manual use, `/team-model <teammate> <provider/model> [thinking]` asks that teammate's extension to switch the session. The teammate model is not asked, so this still works when that model has no quota. The current turn keeps the old model until it ends; the command does not abort it or resume a paused session. `/team-model status` shows pending, applied, and refused requests. Reusing a teammate with `delegate_task` does not change its live model.

## Reloading the Whole Team

After updating pi-teams (or any extension) on disk, run `/team-reload` once in the lead session instead of typing `/reload` in every pane. Each live member reloads itself as soon as it is safe: a busy teammate finishes its current run first and is never interrupted, and pending inbox delivery or an active `team_wait` also defers it. Interrupted sessions reload and stay paused. `/team-reload status` shows which members are `reloaded` or still `pending`, without sending a new request.

Reload is not dispatch; it leaves tasks, mail, and work generations unchanged. It only loads code already on disk, so run `pi update`/`pi install` first. Sessions still running a pi-teams version without this feature need one manual `/reload`.

## Closing teammate panes

`/team-close <member>` closes that one pane and leaves the lead attached. `/team-close` closes every live teammate pane, then exits the lead Pi back to its shell. If a teammate's runtime lease changes during the close, or the terminal refuses the close, that pane stays open and the lead Pi does not exit. The lead pane stays, and the team, tasks, and inbox remain in place. Only the live lead of that same team can run it. A teammate that is already stopped, detached, or dead is reported as `not running` and is not killed again. A restore that has not registered yet is cancelled. Busy teammates are stopped mid-run; their Pi sessions remain resumable. Resume the original lead conversation to reopen only previously open members. `/team-resume <member>` explicitly opens that member's original conversation; `/team-resume` explicitly opens every missing member, including hidden ones. Re-delegating to a closed member also opens its original conversation. Ordinary messages, status checks, and reloads never open hidden panes.

If a hidden teammate’s original process still lives without a verifiable pane, explicit reopen reports blocked and preserves its hidden state; it never duplicates that live conversation. Retry after the process exits.

On tmux, a pane confirmed missing by a successful listing while the lead is alive is kept closed (manual closure and a crash cannot reliably be distinguished). Before whole `/team-close`, a final snapshot catches panes closed before the next poll. Example: A closed and B open → whole close → resume lead → only B reopens. If the lead itself exits, later offline pane losses do not change the last saved intent.

`/team-shutdown confirm` is the explicit deletion of roster, tasks, and inbox after the same close, and only when every pane that needed closing actually closed. Without `confirm` it does nothing. The leader cannot call a delete-team tool. Pi conversation history is kept for a manual `/resume`, without team reattachment. Windows Terminal and Zellij cannot close panes yet. When a teammate or a pending launch still needs closing, both commands refuse and leave every member as it was. A team that is already fully stopped can still be deleted with `confirm`. If a teammate stops or its tmux pane disappears outside these commands, the lead gets one inbox notice.

## 🏗️ Predefined Teams

Predefined teams let you define reusable team templates in a `teams.yaml` file. This is perfect for common workflows where you always want the same set of specialists.

### Define Team Templates

Create `~/.pi/teams.yaml` (global) or `.pi/teams.yaml` in your project:

```yaml
# Full development team
full:
  - scout
  - planner
  - builder
  - reviewer
  - documenter

# Quick plan-build cycle
plan-build:
  - planner
  - builder
  - reviewer

# Research and documentation
research:
  - scout
  - documenter

# Frontend specialists
frontend:
  - planner
  - builder
  - bowser
```

### Define Agent Definitions

Create agent definitions in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local):

**scout.md:**
```markdown
---
name: scout
description: Fast recon and codebase exploration
tools: read,grep,find,ls
---
You are a scout agent. Investigate the codebase quickly and report findings concisely. Do NOT modify any files. Focus on structure, patterns, and key entry points.
```

**builder.md:**
```markdown
---
name: builder
description: Implementation specialist
tools: read,write,edit,bash
model: claude-sonnet-4
thinking: medium
---
You are a builder agent. Implement code following the plan provided. Write clean, tested code.
```

**Agent Definition Fields:**
- `name` (required): The agent's name
- `description` (required): What the agent does
- `tools` (optional): Comma or space-separated list of allowed tools
- `model` (optional): Model to use (e.g., `claude-sonnet-4`, `gpt-4o`)
- `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)

### Use Predefined Teams

**List available team templates:**
> **You:** "List all predefined teams I can use."

**List available agent definitions:**
> **You:** "Show me all predefined agents."

**Launch a collaboration template:**
> **You:** "Start the 'plan-build' template in the current conversation."

This single command:
1. Uses the current main conversation, creating its internal collaboration record if needed
2. Spawns all agents defined in the template
3. Each agent gets its predefined prompt, tools, model, and thinking settings

**With options:**
> **You:** "Start the 'full' template using 'gpt-4o' as default model and separate windows."

---

## 💾 Save Teams as Templates

Sometimes you create a team with custom prompts and settings that you'd like to reuse later. Instead of manually creating `teams.yaml` and agent definition files, you can save any runtime team as a template.

### The Workflow

```
CREATE → USE → SAVE → REUSE
```

1. **Create** a team with custom teammates and prompts
2. **Use** the team for your task
3. **Save** the team as a reusable template
4. **Reuse** the template later (even on different projects)

### Save the Current Collaboration

No runtime-team selection is needed: saving uses the current main conversation's teammates.

### Save a Team as a Template

> **You:** "Save the current teammates as template 'code-modularization'"

This creates:
- Agent definition files in `~/.pi/agent/agents/` for each teammate
- Updates `~/.pi/teams.yaml` with the new template

### Save to Project-Local Scope

To save a template that's specific to the current project:

> **You:** "Save the current teammates as template 'frontend-sprint' with scope 'project'"

This creates files in `.pi/agents/` and `.pi/teams.yaml` in the current project directory.

### Reuse Your Template

Once saved, use it just like any predefined team:

> **You:** "Start the 'code-modularization' template in the current conversation"

---

## 📚 Learn More

- **[Full Usage Guide](docs/guide.md)** - Detailed examples, hook system, best practices, and troubleshooting
- **[Tool Reference](docs/reference.md)** - Complete documentation of all tools and parameters

## 🪟 Terminal Requirements

To show multiple agents on one screen, **pi-teams** requires a way to manage terminal panes. It supports **tmux**, **Zellij**, **iTerm2**, **WezTerm**, and **Windows Terminal**.

### Option 1: tmux (Recommended)

Install tmux:
- **macOS**: `brew install tmux`
- **Linux**: `sudo apt install tmux`

How to run:
```bash
tmux  # Start tmux session
pi   # Start pi inside tmux
```

### Option 2: Zellij

Simply start `pi` inside a Zellij session. **pi-teams** will detect it via the `ZELLIJ` environment variable and use `zellij run` to spawn teammates in new panes.

### Option 3: iTerm2 (macOS)

If you are using **iTerm2** on macOS and are *not* inside tmux or Zellij, **pi-teams** can manage your team in two ways:
1. **Panes (Default)**: Automatically split your current window into an optimized layout.
2. **Windows**: Create true separate OS windows for each agent.

It will name the panes or windows with the teammate's agent name for easy identification.

### Option 4: WezTerm (macOS, Linux, Windows)

**WezTerm** is a GPU-accelerated, cross-platform terminal emulator written in Rust. Like iTerm2, it supports both **Panes** and **Separate OS Windows**.

Install WezTerm:
- **macOS**: `brew install --cask wezterm`
- **Linux**: See [wezterm.org/installation](https://wezterm.org/installation)
- **Windows**: Download from [wezterm.org](https://wezterm.org)

How to run:
```bash
wezterm  # Start WezTerm
pi       # Start pi inside WezTerm
```

### Option 5: Windows Terminal (Windows and WSL)

**Windows Terminal** is the modern, feature-rich terminal emulator for Windows 10/11. It supports both **Panes** and **Separate OS Windows**, including Linux teammates inside WSL without tmux.

**Requirements:**
- Windows 10 (version 19041 or later) or Windows 11
- Windows Terminal installed (available from Microsoft Store or winget)
- For native Windows: Windows PowerShell 5.1 (`powershell.exe`) or PowerShell 7+ (`pwsh.exe`)
- For WSL: Windows interop and Windows PATH integration enabled, with `wt.exe` accessible from the Linux shell

Install Windows Terminal:
- **Microsoft Store**: Search for "Windows Terminal" and install
- **winget**: `winget install Microsoft.WindowsTerminal`
- **Scoop**: `scoop install windows-terminal`

Install PowerShell Core (optional but recommended):
- **winget**: `winget install Microsoft.PowerShell`
- **Scoop**: `scoop install powershell`

How to run:
```powershell
# Open Windows Terminal and start pi
wt
pi
```

Or start pi directly from Windows Terminal with new window:
```powershell
wt -- pwsh -c "pi"
```

**Note:** On native Windows, pi-teams uses PowerShell for command execution. Make sure `pi` is in your PATH. If you installed pi via npm and Node.js, verify both are accessible from PowerShell.

#### WSL (no tmux required)

Open a WSL profile in Windows Terminal, then start Pi normally:

```bash
cd /path/to/project
command -v wt.exe  # Must resolve through Windows PATH integration
pi
```

pi-teams detects Windows Terminal when both `WT_SESSION` and `WSL_DISTRO_NAME` are present. New panes and separate windows run `wsl.exe` with the **same distribution and Linux user**. The launcher restores the requested working directory, `PI_*` variables and the lead's `PATH`, and reuses the exact Node executable for Node-based installs (including NixOS store paths). WSL teammates never run in Windows PowerShell. Standalone Pi installs need a Linux `node` executable in the lead's PATH for the launch bridge.

No additional team settings are required. Pane mode is the default; `separate_windows: true` opens each teammate in a separate Windows Terminal window. Existing tmux, Zellij, cmux and WezTerm sessions retain priority over Windows Terminal.

**Windows Terminal limitations:**
- Pane spawning targets the most recently active Terminal window/tab (`-w 0`). Keep the lead's tab active when spawning; the CLI cannot reliably identify the lead's current pane.
- The first teammate splits vertically; subsequent teammates split the focused pane horizontally. Automatic tmux-style layout balancing is not available.
- The CLI does not expose pane enumeration or arbitrary pane/window termination. WSL teammate health uses the existing runtime PID/start-token and heartbeat mechanism. Where a confirmed process stop is authorized, the adapter marks the launch bridge so it exits with code 0; real failures retain nonzero exit codes. Windows Terminal's `closeOnExit` setting still controls the UI: `graceful`/`always` can close intentionally stopped panes, while `never` keeps them open. pi-teams does not change your Terminal settings. This bridge does not make bulk close reliable: `/team-close` and `/team-shutdown confirm` still refuse if any member or pending launch needs closing. With all members already stopped and no pending launch, confirmed deletion remains allowed.
- Pane spawning uses `-w 0`, Windows Terminal's current/recent-window target. It does not prove exact lead-window selection when multiple Terminal windows are open; `WT_SESSION` is not used as a window ID. Automatic restoration of missing teammate panes remains tmux-only; the WSL launcher does not extend session recovery to Windows Terminal.
- Window/pane titles are set at creation. Other windows cannot be renamed remotely through the CLI.

## 📜 Credits & Attribution

This repository is a fork of [burggraf/pi-teams](https://github.com/burggraf/pi-teams) by Mark Burggraf. Upstream attribution and the MIT license are preserved.

This project is a port of the excellent [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) by [cs50victor](https://github.com/cs50victor).

We have adapted the original MCP coordination protocol to work natively as a **Pi Package**, adding features like auto-starting teammates, balanced vertical UI layouts, automatic inbox delivery, blocking team waits, broadcast messaging, and quality gate hooks.

## 📄 License
MIT
