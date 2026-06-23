export interface AgentRole {
  agentName: string;
  isLead: boolean;
  isTeammate: boolean;
}

export function resolveAgentRole(envAgentName?: string): AgentRole {
  const agentName = envAgentName || "team-lead";
  const isLead = !envAgentName || agentName === "team-lead";

  return {
    agentName,
    isLead,
    isTeammate: !isLead,
  };
}
