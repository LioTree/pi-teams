import fs from "node:fs";
import path from "node:path";
import { TeamConfig, Member } from "./models";
import { configPath, teamDir, taskDir } from "./paths";
import { withLock } from "./lock";
import { atomicWriteJsonSync } from "./atomic-file";

export function teamExists(teamName: string) {
  return fs.existsSync(configPath(teamName));
}

export async function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean
): Promise<TeamConfig> {
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tasksDir = taskDir(name);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    joinedAt: Date.now(),
    tmuxPaneId: process.env.TMUX_PANE || "",
    cwd: process.cwd(),
    subscriptions: [],
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: sessionId,
    members: [leadMember],
    defaultModel,
    separateWindows,
  };

  const p = configPath(name);
  return await withLock(p, async () => {
    if (fs.existsSync(p)) {
      throw new Error(`Team ${name} already exists`);
    }
    atomicWriteJsonSync(p, config);
    return config;
  });
}

function readConfigRaw(p: string): TeamConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as TeamConfig;
}

export async function readConfig(teamName: string): Promise<TeamConfig> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return await withLock(p, async () => readConfigRaw(p));
}

export async function addMember(teamName: string, member: Member) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    if (config.members.some(existing => existing.name === member.name)) {
      throw new Error(`Member ${member.name} already exists in team ${teamName}`);
    }
    config.members.push(member);
    atomicWriteJsonSync(p, config);
  });
}

export async function removeMember(teamName: string, agentName: string) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members = config.members.filter(m => m.name !== agentName);
    atomicWriteJsonSync(p, config);
  });
}

export async function updateMember(teamName: string, agentName: string, updates: Partial<Member>) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const m = config.members.find(m => m.name === agentName);
    if (m) {
      Object.assign(m, updates);
      atomicWriteJsonSync(p, config);
    }
  });
}
