import { describe, expect, it } from "vitest";
import { Member } from "./models";
import {
  buildLeadSystemPrompt,
  buildTeammateSystemPrompt,
  PLAN_MODE_REQUIRED_PROMPT,
  TASK_PLAN_REQUIRED_PROMPT,
} from "./plan-mode-prompt";

describe("buildLeadSystemPrompt", () => {
  it("adds team lead coordination instructions while preserving the base prompt", () => {
    const prompt = buildLeadSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      teamName: "refactor-squad",
    });

    expect(prompt).toContain("team lead");
    expect(prompt).toContain("'refactor-squad'");
    expect(prompt).toContain("Agent Teams skill");
    expect(prompt).toContain("delegate_task");
    expect(prompt).toContain("plan_review");
    expect(prompt).toContain("team_wait");
    expect(prompt).toContain("team_status");
    // The teammate startup directive (block on team_wait for an initial message)
    // must never be injected into the lead prompt — it would deadlock the lead.
    expect(prompt).not.toContain('team_wait(team_name="refactor-squad", event="message")');
  });

  it("tells a lead without a current team to create one when coordination is useful", () => {
    const prompt = buildLeadSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
    });

    expect(prompt).toContain("Create a team with team_create");
  });
});

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

  it("adds default plan mode instructions only when the member requires plan approval", () => {
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
    expect(enabled).toContain("plan_submit");
    expect(enabled).toContain('team_wait(team_name="refactor-squad", event="message")');
    expect(enabled).not.toContain("wait_for_evaluation");
    expect(disabled).not.toContain(PLAN_MODE_REQUIRED_PROMPT);
    expect(disabled).toContain(TASK_PLAN_REQUIRED_PROMPT);
    expect(disabled).toContain("plan_submit");
    expect(disabled).toContain('team_wait(team_name="refactor-squad", event="message")');
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
