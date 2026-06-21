import { describe, expect, it } from "vitest";
import { Member } from "./models";
import { buildTeammateSystemPrompt, PLAN_MODE_REQUIRED_PROMPT } from "./plan-mode-prompt";

describe("buildTeammateSystemPrompt", () => {
  const baseMember: Member = {
    agentId: "refactor-bot@refactor-squad",
    name: "refactor-bot",
    agentType: "teammate",
    joinedAt: 1,
    tmuxPaneId: "%1",
    cwd: "/repo",
    subscriptions: [],
  };

  it("adds plan mode instructions only when the member requires plan approval", () => {
    const enabled = buildTeammateSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      agentName: "refactor-bot",
      teamName: "refactor-squad",
      member: { ...baseMember, planModeRequired: true },
    });

    const disabled = buildTeammateSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      agentName: "refactor-bot",
      teamName: "refactor-squad",
      member: { ...baseMember, planModeRequired: false },
    });

    expect(enabled).toContain(PLAN_MODE_REQUIRED_PROMPT);
    expect(enabled).toContain("task_submit_plan");
    expect(enabled).toContain("waits for the lead to approve or reject");
    expect(enabled).not.toContain("wait_for_evaluation");
    expect(disabled).not.toContain(PLAN_MODE_REQUIRED_PROMPT);
    expect(disabled).not.toContain("task_submit_plan");
    expect(disabled).not.toContain("wait_for_evaluation");
  });

  it("preserves model and thinking metadata in the startup prompt", () => {
    const member: Member = {
      agentId: "refactor-bot@refactor-squad",
      name: "refactor-bot",
      agentType: "teammate",
      model: "test/model",
      thinking: "high",
      joinedAt: 1,
      tmuxPaneId: "%1",
      cwd: "/repo",
      subscriptions: [],
      planModeRequired: true,
    };

    const prompt = buildTeammateSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      agentName: "refactor-bot",
      teamName: "refactor-squad",
      member,
    });

    expect(prompt).toContain("You are currently using model: test/model with thinking level: high.");
  });
});
