import { Member } from "./models";
import type { ControlMode } from "./control-state";

export interface TeammateSystemPromptOptions {
  baseSystemPrompt: string;
  agentName: string;
  teamName?: string | null;
  member?: Member;
  controlMode?: ControlMode;
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
    `\n- Give each teammate a clear role, task, input context, expected output, boundaries, and completion condition.` +
    `\n- After delegating work, call team_wait instead of continuing or duplicating the delegated work.` +
    `\n- When team_wait returns, do coordination work only; if teammates are still active, call team_wait again.` +
    `\n- Use team_status, task_read, and team_message to monitor progress, review evidence, and send corrections.` +
    `\n- Control ownership is separate from activity. A user-controlled teammate keeps working with the human; do not delegate/reuse/replace it until the human runs /team-mode team locally. Held leader reports are released only by local handback or flush. A live user-controlled peer suspends no_active_agents without claiming idle work is progress-capable.` +
    `\n- An interrupted teammate was aborted in its own session. It is not progress-capable and will not auto-resume from inbox mail, but a live interrupted peer keeps an indefinite team_wait open. Recovery is a direct user prompt in that session, not a model change or remote resume.`;
}

export function buildTeammateSystemPrompt(options: TeammateSystemPromptOptions): string {
  const userControlled = options.controlMode === "user";
  const modelInfo = userControlled
    ? "\nThe human controls this original work session and may change its model/thinking. Stored teammate launch settings are not proof of the current selection."
    : buildModelInfo(options.member);

  return options.baseSystemPrompt +
    `\n\nYou are teammate '${options.agentName}' on team '${options.teamName}'.` +
    `\nYour lead is 'team-lead'.${modelInfo}` +
    (userControlled
      ? `\nControl mode: USER. Continue the human's real work in this original session across multiple turns. The harness holds ordinary idle notices, explicit leader reports, task-completion notifications, and a broadcast's leader recipient. Other peers still receive messages. Do not claim a held report was delivered. Only the human's local /team-mode flush or /team-mode team releases reports; handback is not task completion. Idle inbox auto-start is paused, but an already-active explicit dependency team_wait can still consume messages. Already accepted/unknown host requests cannot be revoked by switching mode.`
      : `\nControl mode: TEAM. Your initial assignment and later messages are delivered from your inbox automatically; begin working when they arrive. The human can use /team-mode user to take control and /team-mode team to return it.`) +
    `\nUse team_message to report results, blockers, and dependency requests.` +
    `\nCall team_wait only after sending a dependency request with team_message and only while another active team member must respond; do not call it merely to become idle.` +
    `\nIf this session is interrupted, inbox delivery stays paused until a direct user prompt starts a new run.` +
    `\nAn inbox attempt whose host acceptance is unknown stays unread and is not resent in this process. A new process is deliberate recovery, not exactly-once delivery.`;
}

function buildModelInfo(member?: Member): string {
  if (!member?.model) return "";

  let modelInfo = `\nStored launch model: ${member.model}`;
  if (member.thinking) {
    modelInfo += ` with thinking level: ${member.thinking}`;
  }
  return `${modelInfo}. These are launch settings, not proof of the current runtime selection. Honor the human's latest model/thinking choice; do not switch back or report stale launch metadata as current.`;
}
