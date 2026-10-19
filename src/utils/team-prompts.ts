import { Member } from "./models";

export interface TeammateSystemPromptOptions {
  baseSystemPrompt: string;
  agentName: string;
  teamName?: string | null;
  member?: Member;
}

export interface LeadSystemPromptOptions {
  baseSystemPrompt: string;
  teamName?: string | null;
}

interface TeamSystemPromptEvent {
  readonly systemPrompt: string;
  // Retain a fallback for hosts exposing only the rendered systemPrompt.
  systemPromptOptions?: { sections: Record<string, string> };
}

/** Add role guidance without forcing an opaque prompt on structured-prompt hosts. */
export function applyTeamSystemPrompt(
  event: TeamSystemPromptEvent,
  rolePrompt: string,
): { systemPrompt: string } | undefined {
  const guidance = rolePrompt.trim();
  if (event.systemPromptOptions?.sections) {
    event.systemPromptOptions.sections.pi_teams = guidance;
    return undefined;
  }

  return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
}

export function buildLeadSystemPrompt(options: LeadSystemPromptOptions): string {
  const roleLine = options.teamName
    ? `You are the team lead for team '${options.teamName}'.`
    : "You are the pi-teams team lead. Create a team with team_create when teammate coordination is useful.";

  return options.baseSystemPrompt +
    `\n\n${roleLine}` +
    `\n- Follow the Agent Teams skill guidance for detailed team workflow and tool usage.` +
    `\n- Use delegate_task for significant teammate work so the task board, ownership, initial message, and process lifecycle stay in sync.` +
    `\n- New or follow-up teammate work must use delegate_task, or create_predefined_team for a template launch. An ordinary team_message does not open another inspection, even if it says to continue.` +
    `\n- Give each teammate a clear role, task, input context, expected output, boundaries, and completion condition.` +
    `\n- After delegating work, call team_wait instead of continuing or duplicating the delegated work.` +
    `\n- When team_wait returns, do coordination work only; if teammates are still active, call team_wait again.` +
    `\n- Use team_status, task_read, and team_message to monitor progress, review evidence, and send corrections.` +
    `\n- An interrupted teammate was aborted in its own session. It is not progress-capable and will not auto-resume from inbox mail, but a live interrupted peer keeps an indefinite team_wait open. Recovery is a direct user prompt in that session, not a model change or remote resume.` +
    `\n- Do not close a teammate or the team because work finished or a member is idle. task_complete leaves them on the roster.` +
    `\n- Call team_close or team_resume only when the user explicitly asks to close or reopen a pane. Closing keeps membership and the original session, does not complete tasks, and does not delete the team. Deleting a saved team is the user's /team-shutdown confirm, not a model tool.`;
}

export function buildTeammateSystemPrompt(options: TeammateSystemPromptOptions): string {
  const modelInfo = buildModelInfo(options.member);

  return options.baseSystemPrompt +
    `\n\nYou are teammate '${options.agentName}' on team '${options.teamName}'.` +
    `\nYour lead is 'team-lead'.${modelInfo}` +
    `\nYour initial assignment and later messages are delivered from your inbox automatically; begin working when they arrive.` +
    `\nUse team_message to report results, blockers, and dependency requests. Finishing a task does not remove you from the team.` +
    `\nCall team_wait only after sending a dependency request with team_message and only while another active team member must respond; do not call it merely to become idle.` +
    `\nIf this session is interrupted, inbox delivery stays paused until a direct user prompt starts a new run.` +
    `\nAn inbox attempt whose host acceptance is unknown stays unread and is not resent in this process. A new process is deliberate recovery, not exactly-once delivery.`;
}

function buildModelInfo(member?: Member): string {
  if (!member?.model) return "";

  let modelInfo = `\nYou are currently using model: ${member.model}`;
  if (member.thinking) {
    modelInfo += ` with thinking level: ${member.thinking}`;
  }
  return `${modelInfo}. When reporting your model or thinking level, use these exact values.`;
}
