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
  // Older supported Pi versions expose only the rendered systemPrompt.
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
    `\n- Give each teammate a clear role, task, input context, expected output, boundaries, and completion condition.` +
    `\n- After delegating work, call team_wait instead of continuing or duplicating the delegated work.` +
    `\n- When team_wait returns, do coordination work only; if teammates are still active, call team_wait again.` +
    `\n- Use team_status, task_read, and team_message to monitor progress, review evidence, and send corrections.`;
}

export function buildTeammateSystemPrompt(options: TeammateSystemPromptOptions): string {
  const modelInfo = buildModelInfo(options.member);

  return options.baseSystemPrompt +
    `\n\nYou are teammate '${options.agentName}' on team '${options.teamName}'.` +
    `\nYour lead is 'team-lead'.${modelInfo}` +
    `\nYour initial assignment and later messages are delivered from your inbox automatically; begin working when they arrive.` +
    `\nUse team_message to report results, blockers, and dependency requests.` +
    `\nCall team_wait only after sending a dependency request with team_message and only while another active team member must respond; do not call it merely to become idle.`;
}

function buildModelInfo(member?: Member): string {
  if (!member?.model) return "";

  let modelInfo = `\nYou are currently using model: ${member.model}`;
  if (member.thinking) {
    modelInfo += ` with thinking level: ${member.thinking}`;
  }
  return `${modelInfo}. When reporting your model or thinking level, use these exact values.`;
}
