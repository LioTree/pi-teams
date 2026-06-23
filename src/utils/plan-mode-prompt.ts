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

export interface LeadSystemPromptOptions {
  baseSystemPrompt: string;
  teamName?: string | null;
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
    `\n- Use plan_review to approve or reject submitted teammate plans when plan approval is required.` +
    `\n- After delegating work, use team_wait to wait for plans, task completion, messages, or all tasks done instead of duplicating the delegated work.` +
    `\n- Use team_status, task_read, and team_message to monitor progress, review evidence, and send corrections.`;
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
