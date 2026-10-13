import { describe, expect, it } from "vitest";
import { Member } from "./models";
import { applyTeamSystemPrompt, buildLeadSystemPrompt, buildTeammateSystemPrompt } from "./team-prompts";

describe("applyTeamSystemPrompt", () => {
  it("adds a dedicated section without replacing the rendered prompt or other sections", () => {
    const options = {
      sections: { magic_context: "Memory guidance.", other_extension: "Other guidance." },
      appendSystemPrompt: "User guidance.",
      selectedTools: ["read", "ctx_search"],
    };
    const event = { systemPrompt: "Base system prompt.", systemPromptOptions: options };

    expect(applyTeamSystemPrompt(event, "\n\nTeam guidance.")).toBeUndefined();
    expect(event.systemPrompt).toBe("Base system prompt.");
    expect(options).toEqual({
      sections: {
        magic_context: "Memory guidance.",
        other_extension: "Other guidance.",
        pi_teams: "Team guidance.",
      },
      appendSystemPrompt: "User guidance.",
      selectedTools: ["read", "ctx_search"],
    });
    expect(options).not.toHaveProperty("forceSystemPrompt");
  });

  it.each(["before", "after"])("composes with an MC-style section added %s Teams", (order) => {
    const sections: Record<string, string> = {};
    const event = { systemPrompt: "Base system prompt.", systemPromptOptions: { sections } };
    if (order === "before") sections.magic_context = "Memory guidance.";

    expect(applyTeamSystemPrompt(event, "Team guidance.")).toBeUndefined();
    if (order === "after") sections.magic_context = "Memory guidance.";

    expect(sections).toEqual({ magic_context: "Memory guidance.", pi_teams: "Team guidance." });
  });

  it("replaces its own section on refresh instead of accumulating duplicate guidance", () => {
    const event = { systemPrompt: "Base system prompt.", systemPromptOptions: { sections: { pi_teams: "Old role." } } };
    applyTeamSystemPrompt(event, "New role.");
    applyTeamSystemPrompt(event, "New role.");
    expect(event.systemPromptOptions.sections.pi_teams).toBe("New role.");
  });

  it("does not render the full prompt on structured-prompt hosts", () => {
    const event = {
      get systemPrompt(): string { throw new Error("Full prompt must not be read"); },
      systemPromptOptions: { sections: {} as Record<string, string> },
    };
    expect(applyTeamSystemPrompt(event, "Team guidance.")).toBeUndefined();
    expect(event.systemPromptOptions.sections.pi_teams).toBe("Team guidance.");
  });

  it("uses the legacy return contract when structured prompt options are absent", () => {
    expect(applyTeamSystemPrompt({ systemPrompt: "Base and other extensions." }, "\n\nTeam guidance.")).toEqual({
      systemPrompt: "Base and other extensions.\n\nTeam guidance.",
    });
  });
});

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
