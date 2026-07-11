import { describe, expect, it } from "vitest";
import { Member } from "./models";
import { buildLeadSystemPrompt, buildTeammateSystemPrompt } from "./team-prompts";

describe("buildLeadSystemPrompt", () => {
  it("adds long-running coordination instructions while preserving the base prompt", () => {
    const prompt = buildLeadSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      teamName: "refactor-squad",
    });

    expect(prompt).toContain("Base system prompt.");
    expect(prompt).toContain("team lead");
    expect(prompt).toContain("'refactor-squad'");
    expect(prompt).toContain("delegate_task");
    expect(prompt).toContain("call team_wait");
    expect(prompt).toContain("instead of continuing or duplicating");
    expect(prompt).toContain("if teammates are still active, call team_wait again");
    expect(prompt).toContain("team_status");
    expect(prompt).not.toContain("plan_review");
    expect(prompt).not.toContain("plan_submit");
    expect(prompt).not.toContain("event=");
  });

  it("tells a lead without a current team to create one when coordination is useful", () => {
    const prompt = buildLeadSystemPrompt({ baseSystemPrompt: "Base system prompt." });
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

  it("uses automatic inbox delivery instead of an initial blocking wait", () => {
    const prompt = buildTeammateSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      agentName: "refactor-bot",
      teamName: "refactor-squad",
      member: baseMember,
    });

    expect(prompt).toContain("initial assignment and later messages are delivered");
    expect(prompt).toContain("inbox automatically");
    expect(prompt).not.toContain("Start by calling team_wait");
    expect(prompt).not.toContain("event=");
  });

  it("limits teammate waits to dependencies requested through team_message", () => {
    const prompt = buildTeammateSystemPrompt({
      baseSystemPrompt: "Base system prompt.",
      agentName: "refactor-bot",
      teamName: "refactor-squad",
      member: baseMember,
    });

    expect(prompt).toContain("Use team_message");
    expect(prompt).toContain("Call team_wait only after sending a dependency request");
    expect(prompt).toContain("do not call it merely to become idle");
    expect(prompt).not.toContain("plan approval");
    expect(prompt).not.toContain("plan_submit");
  });

  it("preserves model and thinking metadata", () => {
    const member: Member = {
      ...baseMember,
      model: "test/model",
      thinking: "high",
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
