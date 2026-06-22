import { Member } from "./models";

export const PLAN_MODE_REQUIRED_PROMPT = `Plan approval mode is required for you:
- Before making repository changes or marking implementation work complete, submit a plan with plan_submit.
- plan_submit waits for the lead to approve or reject the plan; do not continue implementation until it returns an approved evaluation.
- If the plan is rejected, use the task feedback to revise and resubmit the plan.
- You may inspect files, read docs, list tasks, wait for team messages, and do other non-mutating analysis before submitting the plan.`;

export const TASK_PLAN_REQUIRED_PROMPT = `If an assigned task or message says plan approval is required, or the task has planRequired=true, submit a plan with plan_submit before making repository changes for that task.`;

export interface TeammateSystemPromptOptions {
  baseSystemPrompt: string;
  agentName: string;
  teamName?: string | null;
  member?: Member;
}

export function buildTeammateSystemPrompt(options: TeammateSystemPromptOptions): string {
  const modelInfo = buildModelInfo(options.member);
  const defaultPlanRequired = options.member?.defaultPlanRequired ?? options.member?.planModeRequired;
  const planModeInfo = defaultPlanRequired
    ? `\n\n${PLAN_MODE_REQUIRED_PROMPT}`
    : `\n\n${TASK_PLAN_REQUIRED_PROMPT}`;

  return options.baseSystemPrompt +
    `\n\nYou are teammate '${options.agentName}' on team '${options.teamName}'.` +
    `\nYour lead is 'team-lead'.${modelInfo}${planModeInfo}` +
    `\nStart by calling team_wait(team_name="${options.teamName}", event="message") to get your initial instructions.`;
}

function buildModelInfo(member?: Member): string {
  if (!member?.model) return "";

  let modelInfo = `\nYou are currently using model: ${member.model}`;
  if (member.thinking) {
    modelInfo += ` with thinking level: ${member.thinking}`;
  }
  return `${modelInfo}. When reporting your model or thinking level, use these exact values.`;
}
