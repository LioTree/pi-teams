import fs from "node:fs";
import path from "node:path";
import { TeamConfig, Member, MemberWindowIntent, WindowIntentReason, WindowIntentState, TeamSession } from "./models";
import { configPath, teamDir, taskDir } from "./paths";
import { withLock } from "./lock";
import { atomicWriteJsonSync } from "./atomic-file";
import { nextWindowIntent, windowIntentEpoch, windowIntentState } from "./window-intent";

/** Error text used to identify our own cancelled recovery launch during rollback. */
export const CLOSE_CANCEL_ERROR = "closed before the restored session registered";

export interface WindowCloseTransition {
  previousIntent?: MemberWindowIntent;
  intent?: MemberWindowIntent;
  changedIntent: boolean;
  cancelledLaunch?: {
    phase: "reserved" | "launched";
    pane?: string;
    windowId?: string;
  };
}

export function teamExists(teamName: string) {
  return fs.existsSync(configPath(teamName));
}

export async function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean,
  internal?: boolean,
  leadSession?: TeamSession,
): Promise<TeamConfig> {
  if (leadSession && leadSession.id !== sessionId) throw new Error("Initial lead session identity mismatch");
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tasksDir = taskDir(name);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    session: leadSession,
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
    internal: internal || undefined,
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

/** Update team-level settings without touching the roster. */
export async function updateTeam(
  teamName: string,
  updates: Partial<Pick<TeamConfig, "defaultModel" | "separateWindows">>,
) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    Object.assign(config, updates);
    atomicWriteJsonSync(p, config);
  });
}

/**
 * Set one member's pane/window intent. Missing legacy metadata is `open`.
 * An expected epoch makes this compare-and-set against a newer resume/close.
 */
export async function setWindowIntent(
  teamName: string,
  agentName: string,
  state: WindowIntentState,
  reason: WindowIntentReason,
  expectedEpoch?: number,
): Promise<{ intent: MemberWindowIntent; previous?: MemberWindowIntent; changed: boolean } | null> {
  const p = configPath(teamName);
  return await withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find(item => item.name === agentName);
    if (!member) return null;
    const previous = member.windowIntent;
    if (expectedEpoch !== undefined && windowIntentEpoch(member) !== expectedEpoch) return null;
    if (windowIntentState(member) === state) {
      return previous
        ? { intent: previous, previous, changed: false }
        : { intent: nextWindowIntent(previous, state, reason), previous, changed: false };
    }
    const intent = nextWindowIntent(previous, state, reason);
    member.windowIntent = intent;
    atomicWriteJsonSync(p, config);
    return { intent, previous, changed: true };
  });
}

/**
 * Atomically record a close intent and cancel a not-yet-registered recovery
 * launch. The caller performs the terminal action, then rolls this back on a
 * failed or lease-changed close. `activity` is never used as close intent.
 */
export async function beginWindowClose(
  teamName: string,
  agentName: string,
  reason: "close-member" | "close-team",
  options: { preserveIntent?: boolean; requireCloseableLaunch?: () => void } = {},
): Promise<WindowCloseTransition> {
  const p = configPath(teamName);
  return await withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find(item => item.name === agentName);
    if (!member) throw new Error(`Member ${agentName} not found in team ${teamName}`);

    const phase = member.recovery?.phase;
    // Recheck at the actual mutation point: a launch may appear after preflight.
    if (member.recovery && phase !== "attached" && phase !== "failed") {
      options.requireCloseableLaunch?.();
    }
    const previousIntent = member.windowIntent;
    const changedIntent = !options.preserveIntent && windowIntentState(member) !== "closed";
    if (changedIntent) member.windowIntent = nextWindowIntent(previousIntent, "closed", reason);

    let cancelledLaunch: WindowCloseTransition["cancelledLaunch"];
    if (member.recovery && phase !== "attached" && phase !== "failed") {
      cancelledLaunch = {
        phase: phase === "launched" ? "launched" : "reserved",
        ...(phase === "launched" && member.tmuxPaneId ? { pane: member.tmuxPaneId } : {}),
        ...(phase === "launched" && member.windowId ? { windowId: member.windowId } : {}),
      };
      member.recovery.phase = "failed";
      member.recovery.error = CLOSE_CANCEL_ERROR;
    }

    if (changedIntent || cancelledLaunch) atomicWriteJsonSync(p, config);
    return {
      previousIntent,
      intent: member.windowIntent,
      changedIntent,
      cancelledLaunch,
    };
  });
}

/** Roll back only this close's exact intent epoch; never erase a newer intent. */
export async function rollbackWindowClose(
  teamName: string,
  agentName: string,
  expectedEpoch: number,
  previousIntent: MemberWindowIntent | undefined,
  restoreLaunchPhase?: "reserved" | "launched",
): Promise<boolean> {
  const p = configPath(teamName);
  return await withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find(item => item.name === agentName);
    if (!member || windowIntentEpoch(member) !== expectedEpoch) return false;

    // Undo the state, not the revision: never reuse an epoch after a failed
    // close (an older observation must not pass CAS via an ABA rollback).
    if (windowIntentEpoch(member) !== (previousIntent?.epoch ?? 0)) {
      member.windowIntent = nextWindowIntent(member.windowIntent, previousIntent?.state ?? "open", "rollback");
    }

    if (restoreLaunchPhase && member.recovery?.phase === "failed"
      && member.recovery.error === CLOSE_CANCEL_ERROR) {
      member.recovery.phase = restoreLaunchPhase;
      delete member.recovery.error;
    }
    atomicWriteJsonSync(p, config);
    return true;
  });
}
