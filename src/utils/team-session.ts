import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { atomicWriteJsonSync } from "./atomic-file";
import { withLock } from "./lock";
import * as paths from "./paths";
import type { Member, TeamConfig, TeamSession } from "./models";
import * as runtime from "./runtime";
import type { TerminalAdapter } from "./terminal-adapter";
import { buildPiCommand, getProjectTrustArg } from "./pi-command";

/** Canonicalize without requiring a not-yet-flushed Pi session file to exist. */
export function canonicalSessionFile(file: string): string {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
}

export function sessionIdentity(ctx: { sessionManager?: {
  getSessionId(): string; getSessionFile(): string | undefined; getCwd(): string;
} }): TeamSession | undefined {
  const manager = ctx.sessionManager;
  const file = manager?.getSessionFile();
  if (!manager || !file) return undefined;
  return {
    id: manager.getSessionId(), file: canonicalSessionFile(file),
    cwd: path.resolve(manager.getCwd()), confirmed: true, trustArg: getProjectTrustArg(),
    agentDir: path.resolve(getAgentDir()),
  };
}

export function sameSession(a: TeamSession | undefined, b: TeamSession | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.file === b.file;
}

/** Reserve the exact file and ID before the first process launch. No prompt/history. */
export function allocateSession(teamName: string, cwd: string): TeamSession {
  // Let Pi choose UUID, header, filename and per-project/agentDir storage.
  // Team dissolution deletes its metadata directory, never conversation history.
  const manager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR || undefined);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi did not allocate a persistent session");
  const canonical = canonicalSessionFile(file);
  const roots = [paths.TEAMS_DIR, paths.TASKS_DIR,
    path.dirname(paths.teamDir(teamName)), path.dirname(paths.taskDir(teamName))];
  for (const root of roots) {
    const real = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    if (canonical === real || canonical.startsWith(real + path.sep)) {
      throw new Error("Pi conversation storage overlaps deletable team/task storage; allocation refused");
    }
  }
  const session: TeamSession = {
    id: manager.getSessionId(), file: canonical, cwd: manager.getCwd(), confirmed: false,
    trustArg: getProjectTrustArg(),
    agentDir: path.resolve(getAgentDir()),
  };
  // SDK intentionally defers the header until conversation begins. Reserve only
  // that SDK-generated header now, without creating a prompt/model/history entry.
  fs.writeFileSync(file, JSON.stringify(header) + "\n", { flag: "wx" });
  return session;
}

export function validateSession(session: TeamSession): void {
  if (!path.isAbsolute(session.file)) throw new Error("original session path is not absolute");
  // Identity comes only from the header/mapping, never from conversation text.
  if (!fs.statSync(session.cwd).isDirectory()) throw new Error("original working directory is unavailable");
  const fd = fs.openSync(session.file, "r");
  try {
    const buffer = Buffer.alloc(16384);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, n).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(line);
    // A truncated/corrupt known file is a recovery fault, not permission to start
    // a blank replacement. Parse framing only; do not infer roles from messages.
    for (const row of fs.readFileSync(session.file, "utf8").split("\n")) {
      if (row.trim()) JSON.parse(row);
    }
    if (header.type !== "session" || header.id !== session.id || !header.cwd
      || path.resolve(header.cwd) !== session.cwd || canonicalSessionFile(session.file) !== session.file) {
      throw new Error("original session header does not match the saved identity");
    }
  } finally { fs.closeSync(fd); }
}

export function findSessionMember(identity: TeamSession, hint?: string): { teamName: string; member: Member } | undefined {
  let found: { teamName: string; member: Member } | undefined;
  const names = new Set(paths.listTeamNames());
  if (hint) names.add(paths.sanitizeName(hint));
  for (const name of names) {
    try {
      const config = JSON.parse(fs.readFileSync(paths.configPath(name), "utf8")) as TeamConfig;
      for (const member of config.members) {
        if (!sameSession(member.session, identity)) continue;
        if (found) throw new Error("Pi session is associated with more than one team member");
        found = { teamName: name, member };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("more than one")) throw error;
      // Corrupt unrelated team metadata cannot identify this session.
    }
  }
  return found;
}

function readConfig(team: string): TeamConfig {
  return JSON.parse(fs.readFileSync(paths.configPath(team), "utf8"));
}

function assertNoOrphanLivePid(team: string, member: Member): void {
  const file = member.agentType === "lead" ? paths.leadSessionPath(team) : path.join(paths.teamDir(team), `${member.name}.pid`);
  if (!fs.existsSync(file)) return;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const evidence = member.agentType === "lead" ? parsed : { pid: parsed };
  if (runtime.isRuntimeProcessAlive(evidence)) throw new Error("live PID evidence exists without runtime identity; refusing takeover/duplicate");
}

/** Establish identity, exclusive runtime authority, and confirmation in one locked admission. */
export async function claimSession(input: {
  team: string; agent: string; identity: TeamSession; instanceId: string;
  pid: number; processStartToken?: string; paneId?: string; handoffToken?: string; recoveryToken?: string;
  legacyReload?: boolean; sameProcessReload?: boolean; manualAssociation?: boolean;
  alive?: typeof runtime.isRuntimeProcessAlive; current?: () => boolean;
}): Promise<runtime.AgentRuntimeStatus> {
  const configFile = paths.configPath(input.team);
  return withLock(configFile, async () => {
    const config = readConfig(input.team);
    const member = config.members.find(m => m.name === input.agent);
    if (!member) throw new Error("member was explicitly removed; recovery refused");
    const runtimeFile = paths.runtimeStatusPath(input.team, input.agent);
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    return withLock(runtimeFile, async () => {
      if (input.current && !input.current()) throw new Error("session attachment superseded");
      const previous = runtime.readRuntimeStatusSync(input.team, input.agent);
      if (!previous) assertNoOrphanLivePid(input.team, member);
      if (input.recoveryToken && (member.recovery?.token !== input.recoveryToken || member.recovery.phase === "failed")) {
        throw new Error("recovery launch reservation superseded; stale child cannot attach");
      }
      const handoff = !!input.handoffToken && previous?.instanceId === input.handoffToken
        && previous.activity === "starting";
      const ownedLegacy = input.legacyReload && !member.session
        && previous?.pid === input.pid && previous.processStartToken === input.processStartToken
        && previous.sessionId === input.identity.id && previous.sessionFile === input.identity.file;
      // PID-only legacy records cannot prove which conversation is reloaded.
      // Never borrow an identity from a lingering env or an unrelated /new.
      const alive = input.alive ?? runtime.isRuntimeProcessAlive;
      let manualLegacy = false;
      if (input.manualAssociation && member.agentType === "lead" && !member.session) {
        if (previous && alive(previous)) throw new Error("legacy lead process is still alive; explicit association cannot force takeover");
        const advisoryFile = paths.leadSessionPath(input.team);
        if (fs.existsSync(advisoryFile)) {
          const advisory = JSON.parse(fs.readFileSync(advisoryFile, "utf8"));
          if (alive(advisory)) throw new Error("legacy lead PID is still alive; association refused");
        }
        manualLegacy = true;
      }
      if (!handoff && !sameSession(member.session, input.identity) && !ownedLegacy && !manualLegacy) {
        throw new Error("no exact saved Pi session mapping; legacy recovery is blocked (data preserved)");
      }
      // A reload replaces only the extension instance; the previous owner is this
      // exact process (PID + start token) on this exact conversation. Hosts without
      // a start token (non-Linux) cannot prove the process through /proc, so there
      // the re-claim additionally requires the `reloading` marker this process's
      // own shutdown wrote, alongside the matching live PID and conversation.
      const tokenProvesProcess = !!previous && previous.processStartToken !== undefined
        && previous.processStartToken === input.processStartToken;
      const markerProvesProcess = !!previous && previous.processStartToken === undefined
        && input.processStartToken === undefined && previous.reloading === true;
      const ownReload = !!input.sameProcessReload && !!previous && previous.pid === input.pid
        && (tokenProvesProcess || markerProvesProcess)
        && previous.sessionId === input.identity.id && previous.sessionFile === input.identity.file;
      if (!handoff && !ownedLegacy && !ownReload && previous?.instanceId !== input.instanceId && previous && !previous.detached && alive(previous)) {
        throw new Error("another live process owns this member; no takeover or duplicate launch");
      }
      const paused = previous?.paused || previous?.activity === "interrupted";
      const next: runtime.AgentRuntimeStatus = {
        ...previous,
        teamName: input.team, agentName: input.agent,
        activity: paused ? "interrupted" : "idle", paused: !!paused, detached: false, reloading: undefined, reloadingSince: undefined,
        instanceId: input.instanceId, pid: input.pid, processStartToken: input.processStartToken,
        sessionId: input.identity.id, sessionFile: input.identity.file,
        activityChangedAt: Date.now(), startedAt: Date.now(), lastHeartbeatAt: Date.now(),
      };
      member.session = { ...member.session, ...input.identity, confirmed: true };
      member.cwd = input.identity.cwd;
      if (input.paneId) member.tmuxPaneId = input.paneId;
      // Child registration resolves a parent launch whose metadata update failed.
      if (member.recovery) member.recovery.phase = "attached";
      if (member.agentType === "lead") config.leadSessionId = input.identity.id;
      atomicWriteJsonSync(configFile, config);
      atomicWriteJsonSync(runtimeFile, next);
      // Advisory PID record is not the exclusive lease. A failure here must not
      // strand a successfully committed runtime owner without an inbox reader.
      if (member.agentType === "lead") {
        try { atomicWriteJsonSync(paths.leadSessionPath(input.team), {
          pid: input.pid, processStartToken: input.processStartToken,
          sessionId: input.identity.id, sessionFile: input.identity.file, instanceId: input.instanceId,
          startedAt: Date.now(),
        }); } catch { /* canonical mapping + runtime lease remain authoritative */ }
      }
      return next;
    });
  });
}

export interface RecoveryOutcome { name: string; status: "alive" | "restored" | "pending" | "blocked"; note?: string }

/** One bounded pass. Restoration is NOT task dispatch and sends no model prompt. */
export async function restoreTeamPanes(input: {
  team: string; leaderInstanceId: string; terminal: TerminalAdapter | null;
  piBinary: string; anchorPaneId?: string; members?: string[]; current?: () => boolean;
  alive?: typeof runtime.isRuntimeProcessAlive;
}): Promise<RecoveryOutcome[]> {
  const outcomes: RecoveryOutcome[] = [];
  const names = readConfig(input.team).members.filter(m => m.agentType !== "lead" && (!input.members || input.members.includes(m.name))).map(m => m.name);
  for (const name of names) {
    const configFile = paths.configPath(input.team);
    try {
      const result = await withLock(configFile, async (): Promise<RecoveryOutcome> => {
        const config = readConfig(input.team);
        const member = config.members.find(m => m.name === name);
        if (!member) return { name, status: "blocked", note: "member removed" };
        const leader = await runtime.readRuntimeStatus(input.team, "team-lead");
        if (input.current && !input.current() || leader?.instanceId !== input.leaderInstanceId || leader.detached || leader.activity === "stopped") {
          return { name, status: "blocked", note: "lead authority lost" };
        }
        const status = await runtime.readRuntimeStatus(input.team, name);
        if (!status) assertNoOrphanLivePid(input.team, member);
        if (status && (input.alive ?? runtime.isRuntimeProcessAlive)(status) && !status.detached) {
          if (member.session && (status.sessionId !== member.session.id || status.sessionFile !== member.session.file)) {
            return { name, status: "blocked", note: "live process has unconfirmed/different session identity; retained, not duplicated" };
          }
          return { name, status: "alive", note: "live process retained (pane id alone is not identity)" };
        }
        if (!member.session) throw new Error("no saved Pi session mapping (legacy member preserved)");
        validateSession(member.session);
        if (!member.session.confirmed) throw new Error("original process never confirmed this session; no blank recovery launch");
        if (input.terminal?.name !== "tmux") throw new Error("automatic pane restoration requires tmux; lead inbox remains attached");
        if (input.current && !input.current()) throw new Error("session detached before reconciliation");
        if (member.recovery && member.recovery.phase !== "attached") {
          const pane = input.terminal.findRecoveryPane?.(member.recovery.token);
          if (pane) {
            member.tmuxPaneId = pane;
            member.recovery.phase = "launched";
            atomicWriteJsonSync(configFile, config);
            return { name, status: "pending", note: "existing nonce-matched launch retained; waiting for session registration" };
          }
          if (member.recovery.phase !== "failed") return {
            name, status: "blocked", note: "earlier launch outcome is unknown; refusing a duplicate (reload after child registers)",
          };
        }
        if (input.current && !input.current()) throw new Error("session detached before launch");
        const savedSession = member.session;
        const terminal = input.terminal;
        // Keep authority stable through the synchronous launch/commit. Lock
        // ordering matches admission: config -> runtime; no runtime -> config.
        return withLock(paths.runtimeStatusPath(input.team, "team-lead"), async () => {
          const latestLead = runtime.readRuntimeStatusSync(input.team, "team-lead");
          if (input.current && !input.current() || latestLead?.instanceId !== input.leaderInstanceId || latestLead.detached || latestLead.activity === "stopped") {
            throw new Error("lead authority changed before launch");
          }
          const token = randomUUID();
          member.recovery = { token, ownerInstanceId: input.leaderInstanceId, phase: "reserved" };
          atomicWriteJsonSync(configFile, config);
          try {
            const env: Record<string, string> = {
              ...process.env as Record<string, string>,
              PI_TEAM_NAME: input.team, PI_AGENT_NAME: name, PI_TEAM_RECOVERY_TOKEN: token,
            };
            delete env.PI_TEAM_HANDOFF_TOKEN;
            delete env.PI_SESSION_ID;
            delete env.PI_SESSION_FILE;
            delete env.PI_MODEL;
            if (savedSession.agentDir) env.PI_CODING_AGENT_DIR = savedSession.agentDir;
            const pane = terminal.spawn({ name, cwd: savedSession.cwd,
              command: buildPiCommand(input.piBinary, undefined, undefined, savedSession.trustArg ?? null, savedSession.file),
              env, anchorPaneId: input.anchorPaneId, recoveryToken: token });
            member.tmuxPaneId = pane;
            member.recovery.phase = "launched";
            atomicWriteJsonSync(configFile, config);
            return { name, status: "restored", note: "pane launched for original session; registration pending, no task replay or model override" };
          } catch (error) {
            member.recovery.error = error instanceof Error ? error.message : String(error);
            // Only a terminal adapter's definite pre-launch rejection permits retry.
            if ((error as { spawned?: boolean }).spawned === false) member.recovery.phase = "failed";
            atomicWriteJsonSync(configFile, config);
            throw error;
          }
        });
      });
      outcomes.push(result);
    } catch (error) {
      outcomes.push({ name, status: "blocked", note: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
