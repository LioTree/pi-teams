import { Member } from "./models";

export const PLAN_MODE_REQUIRED_PROMPT = `Plan approval mode is required for you:
- Before making repository changes or marking implementation work complete, submit a plan with task_submit_plan and set wait_for_evaluation to true.
- Wait until task_submit_plan returns an approved evaluation before editing files or executing the implementation.
- If the plan is rejected, use the task feedback to revise and resubmit the plan.
- You may inspect files, read docs, list tasks, read your inbox, and do other non-mutating analysis before submitting the plan.`;

export interface TeammateSystemPromptOptions {
  baseSystemPrompt: string;
  agentName: string;
  teamName?: string | null;
  member?: Member;
}

export function buildTeammateSystemPrompt(options: TeammateSystemPromptOptions): string {
  const modelInfo = buildModelInfo(options.member);
  const planModeInfo = options.member?.planModeRequired ? `\n\n${PLAN_MODE_REQUIRED_PROMPT}` : "";

  return options.baseSystemPrompt +
    `\n\nYou are teammate '${options.agentName}' on team '${options.teamName}'.` +
    `\nYour lead is 'team-lead'.${modelInfo}${planModeInfo}` +
    `\nStart by calling read_inbox(team_name="${options.teamName}") to get your initial instructions.`;
}

function buildModelInfo(member?: Member): string {
  if (!member?.model) return "";

  let modelInfo = `\nYou are currently using model: ${member.model}`;
  if (member.thinking) {
    modelInfo += ` with thinking level: ${member.thinking}`;
  }
  return `${modelInfo}. When reporting your model or thinking level, use these exact values.`;
}
