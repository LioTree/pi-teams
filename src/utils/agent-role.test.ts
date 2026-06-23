import { describe, expect, it } from "vitest";
import { resolveAgentRole } from "./agent-role";

describe("resolveAgentRole", () => {
  it("treats a process without PI_AGENT_NAME as the team lead", () => {
    expect(resolveAgentRole(undefined)).toEqual({
      agentName: "team-lead",
      isLead: true,
      isTeammate: false,
    });
  });

  it("treats PI_AGENT_NAME=team-lead as the team lead", () => {
    expect(resolveAgentRole("team-lead")).toEqual({
      agentName: "team-lead",
      isLead: true,
      isTeammate: false,
    });
  });

  it("treats other PI_AGENT_NAME values as teammates", () => {
    expect(resolveAgentRole("builder")).toEqual({
      agentName: "builder",
      isLead: false,
      isTeammate: true,
    });
  });
});
