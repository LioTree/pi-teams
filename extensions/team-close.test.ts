import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import { allocateSession, claimSession } from "../src/utils/team-session";
import type { TeamSession } from "../src/utils/models";

const terminalState: { adapter: any } = { adapter: null };
vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => terminalState.adapter,
}));
let root: string;
let leadIdentity: TeamSession;
let peerIdentity: TeamSession;
const team = "close-team";
const loaded: any[] = [];

function make(identity: TeamSession) {
  const handlers = new Map<string, any>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const sent: string[] = [];
  let idle = true;
  const ctx: any = { sessionManager: SessionManager.open(identity.file), isIdle: () => idle, cwd: root,
    reload: vi.fn(async () => {}), shutdown: vi.fn(), ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } };
  extension({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text) } as any);
  const object = { handlers, tools, commands, sent, ctx, setIdle: (value: boolean) => { idle = value; },
    emit: (name: string, event: any = {}) => handlers.get(name)({ type: name, ...event }, ctx) };
  loaded.push(object); return object;
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

function fakeTerminal() {
  return { name: "tmux", detect: () => true, findRecoveryPane: () => undefined,
    spawn: vi.fn(() => "%spawned"), isAlive: () => true, setTitle: vi.fn(),
    supportsWindows: () => false, spawnWindow: vi.fn(), setWindowTitle: vi.fn(),
    killWindow: vi.fn(), isWindowAlive: () => false,
    kill: vi.fn() } as any;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-close-"));
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockReturnValue([team]);
  vi.stubEnv("PI_TEAM_NAME", undefined); vi.stubEnv("PI_AGENT_NAME", undefined); vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", undefined);
  // The test runner may itself live in a tmux pane; keep it out of member metadata.
  vi.stubEnv("TMUX_PANE", undefined); vi.stubEnv("TMUX", undefined);
  await teams.createTeam(team, "legacy", "lead");
  leadIdentity = allocateSession(team, root); peerIdentity = allocateSession(team, root);
  await teams.updateMember(team, "team-lead", { session: leadIdentity });
  await teams.addMember(team, { name: "peer", agentId: "peer@close", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%peer", cwd: root, subscriptions: [], session: { ...peerIdentity, confirmed: true } });
  terminalState.adapter = fakeTerminal();
});
afterEach(async () => {
  for (const target of loaded.splice(0)) await target.emit("session_shutdown").catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});

/** Attach lead and peer; remove the peer pid file so killTeammate's SIGKILL
 * path can never target this real test process. */
async function attachBoth() {
  // The peer must claim first: once the lead attaches it restores missing
  // roster peers, which would spawn a replacement pane in this fixture.
  const peer = make(peerIdentity); await peer.emit("session_start", { reason: "startup" });
  const lead = make(leadIdentity); await lead.emit("session_start", { reason: "startup" }); await drain();
  fs.rmSync(path.join(paths.teamDir(team), "peer.pid"), { force: true });
  return { lead, peer };
}

describe("team-close and team-shutdown user commands", () => {
  it("/team-close closes a live teammate pane, marks it stopped, and preserves team data", async () => {
    const { lead } = await attachBoth();
    await lead.commands.get("team-close").handler("", lead.ctx);
    expect(terminalState.adapter.kill).toHaveBeenCalledWith("%peer");
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).toBe("stopped");
    // Data preserved for later recovery: config, runtime records, roster.
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect(fs.existsSync(paths.runtimeStatusPath(team, "peer"))).toBe(true);
    expect((await teams.readConfig(team)).members).toHaveLength(2);
    // The lead itself stays attached and is not stopped.
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.activity).not.toBe("stopped");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("peer: closed");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("data preserved");
  }, 10_000);

  it("/team-close reports an already stopped teammate without killing its pane again", async () => {
    const { lead } = await attachBoth();
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: 99999999, processStartToken: undefined });
    await lead.commands.get("team-close").handler(team, lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("peer: not running");
  }, 10_000);

  it("/team-shutdown closes panes, deletes team data, and preserves Pi history", async () => {
    const { lead } = await attachBoth();
    fs.mkdirSync(paths.taskDir(team), { recursive: true });
    fs.writeFileSync(path.join(paths.taskDir(team), "1.json"), '{"id":"1","status":"in_progress","owner":"peer"}');
    const before = fs.readFileSync(peerIdentity.file);
    await lead.commands.get("team-shutdown").handler("", lead.ctx);
    expect(terminalState.adapter.kill).toHaveBeenCalledWith("%peer");
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(paths.taskDir(team))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(team, "peer"))).toBe(false);
    expect(fs.readFileSync(peerIdentity.file).equals(before)).toBe(true);
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("shut down");
  }, 10_000);

  it("shutdown skips an already stopped teammate instead of killing its pane again", async () => {
    const { lead } = await attachBoth();
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: 99999999, processStartToken: undefined });
    await lead.commands.get("team-shutdown").handler(team, lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("an unattached session cannot close or shut down a team by name", async () => {
    await attachBoth();
    const stranger = make(allocateSession(team, root));
    await stranger.emit("session_start", { reason: "startup" });
    await expect(stranger.commands.get("team-close").handler(team, stranger.ctx)).rejects.toThrow("live lead");
    await expect(stranger.tools.get("team_shutdown").execute("x", { team_name: team }, undefined, undefined, stranger.ctx))
      .rejects.toThrow("live lead");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
  }, 10_000);

  it("the live lead of another team cannot close this team", async () => {
    await attachBoth();
    vi.mocked(paths.listTeamNames).mockReturnValue([team, "other-team"]);
    await teams.createTeam("other-team", "other", "lead");
    const otherLead = allocateSession("other-team", root);
    await teams.updateMember("other-team", "team-lead", { session: otherLead });
    const other = make(otherLead);
    await other.emit("session_start", { reason: "startup" });
    await expect(other.commands.get("team-close").handler(team, other.ctx)).rejects.toThrow("live lead");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await teams.readConfig(team)).members).toHaveLength(2);
  }, 10_000);

  it("close cancels a pending recovery launch and its child cannot attach afterward", async () => {
    const lead = make(leadIdentity);
    await lead.emit("session_start", { reason: "startup" });
    await drain();
    const recovery = (await teams.readConfig(team)).members.find(member => member.name === "peer")?.recovery;
    expect(recovery?.phase).toBe("launched");
    expect(terminalState.adapter.spawn).toHaveBeenCalled();
    await lead.commands.get("team-close").handler("", lead.ctx);
    expect(terminalState.adapter.kill).toHaveBeenCalled();
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")?.recovery?.phase).toBe("failed");
    await expect(claimSession({
      team, agent: "peer", identity: peerIdentity, instanceId: "late-child",
      pid: process.pid, processStartToken: runtime.getProcessStartToken(process.pid),
      recoveryToken: recovery?.token,
    })).rejects.toThrow("superseded");
  }, 10_000);

  it("does not SIGKILL when the current process start token cannot be read", async () => {
    const { lead } = await attachBoth();
    const current = (await runtime.readRuntimeStatus(team, "peer"))!;
    await runtime.setRuntimeActivity(team, "peer", "idle", {
      pid: process.pid, processStartToken: "stale-token", instanceId: current.instanceId,
      sessionId: current.sessionId, sessionFile: current.sessionFile,
    });
    fs.writeFileSync(path.join(paths.teamDir(team), "peer.pid"), String(process.pid));
    const readFile = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, encoding) => {
      const target = String(file);
      if (target.includes(`${path.sep}proc${path.sep}`) && target.endsWith(`${path.sep}stat`)) {
        const error = new Error("EACCES") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return readFile.call(fs, file as any, encoding as any);
    });
    const signals: Array<string | number> = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal !== undefined) signals.push(signal);
      return true;
    });
    await lead.commands.get("team-close").handler("", lead.ctx);
    expect(signals).not.toContain("SIGKILL");
    expect(terminalState.adapter.kill).toHaveBeenCalledWith("%peer");
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).toBe("stopped");
  }, 10_000);

  it("a lost runtime lease does not kill the pane or report it closed", async () => {
    const { lead } = await attachBoth();
    vi.spyOn(runtime, "replaceRuntimeInstance").mockResolvedValue(null);
    await lead.commands.get("team-close").handler("", lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("lease changed");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).not.toContain("peer: closed");
  }, 10_000);

  it("Windows Terminal and Zellij refuse to close and leave the member running", async () => {
    const { lead } = await attachBoth();
    for (const name of ["windows", "zellij"]) {
      terminalState.adapter.name = name;
      terminalState.adapter.kill.mockClear();
      await expect(lead.commands.get("team-close").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
      expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
      expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    }
    terminalState.adapter.name = "zellij";
    await expect(lead.commands.get("team-shutdown").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
  }, 10_000);

  async function seedWindowOnlyLaunch(windowId: string) {
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: undefined, processStartToken: undefined });
    await teams.updateMember(team, "peer", {
      tmuxPaneId: "",
      windowId,
      recovery: { token: `window-${windowId}`, ownerInstanceId: "restore-owner", phase: "launched" },
    });
  }

  it("a pending separate window is closed even when it has no pane id", async () => {
    const { lead } = await attachBoth();
    await seedWindowOnlyLaunch("win-close");
    await lead.commands.get("team-close").handler("", lead.ctx);
    expect(terminalState.adapter.killWindow).toHaveBeenCalledWith("win-close");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")?.recovery?.phase).toBe("failed");

    await seedWindowOnlyLaunch("win-shutdown");
    await lead.commands.get("team-shutdown").handler("", lead.ctx);
    expect(terminalState.adapter.killWindow).toHaveBeenCalledWith("win-shutdown");
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("the shutdown tool closes a pending separate window before deleting the team", async () => {
    const { lead } = await attachBoth();
    await seedWindowOnlyLaunch("win-tool");
    await lead.tools.get("team_shutdown").execute("x", { team_name: team }, undefined, undefined, lead.ctx);
    expect(terminalState.adapter.killWindow).toHaveBeenCalledWith("win-tool");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
  }, 10_000);

  it("replacement and approved shutdown do not claim a lost lease was closed", async () => {
    const { lead } = await attachBoth();
    vi.spyOn(runtime, "replaceRuntimeInstance").mockResolvedValue(null);
    const membersBefore = JSON.stringify((await teams.readConfig(team)).members);
    const runtimeBefore = await runtime.readRuntimeStatus(team, "peer");
    terminalState.adapter.spawn.mockClear();
    await expect(lead.tools.get("delegate_task").execute("x", {
      team_name: team, teammate_name: "peer", cwd: root,
      task_subject: "replace", task_description: "replace the peer", reuse: "replace",
    }, undefined, undefined, lead.ctx)).rejects.toThrow("lease changed");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify((await teams.readConfig(team)).members)).toBe(membersBefore);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.instanceId).toBe(runtimeBefore?.instanceId);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("starting");

    await expect(lead.tools.get("process_shutdown_approved").execute("x", {
      team_name: team, agent_name: "peer",
    }, undefined, undefined, lead.ctx)).rejects.toThrow("lease changed");
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")).toBeUndefined();
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
  }, 10_000);

  it("a replaced lead instance cannot close or shut the team down", async () => {
    const { lead } = await attachBoth();
    const status = (await runtime.readRuntimeStatus(team, "team-lead"))!;
    const transferred = await runtime.replaceRuntimeInstance(team, "team-lead", status.instanceId!, "replacement-lead", {
      activity: "running",
    });
    expect(transferred?.instanceId).toBe("replacement-lead");
    const peerBefore = JSON.stringify(await runtime.readRuntimeStatus(team, "peer"));
    await expect(lead.commands.get("team-close").handler("", lead.ctx)).rejects.toThrow("live lead");
    await expect(lead.commands.get("team-shutdown").handler("", lead.ctx)).rejects.toThrow("live lead");
    await expect(lead.tools.get("team_shutdown").execute("x", { team_name: team }, undefined, undefined, lead.ctx))
      .rejects.toThrow("live lead");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(JSON.stringify(await runtime.readRuntimeStatus(team, "peer"))).toBe(peerBefore);
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
  }, 10_000);

  it("an unsupported terminal still refuses when a stopped peer is live again before the write", async () => {
    const { lead } = await attachBoth();
    terminalState.adapter.name = "windows";
    const realRead = runtime.readRuntimeStatus.bind(runtime);
    let peerReads = 0;
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (teamName, agent) => {
      const status = await realRead(teamName, agent);
      if (agent !== "peer" || !status) return status;
      peerReads += 1;
      if (peerReads === 1) return { ...status, activity: "stopped", pid: undefined };
      return status;
    });
    await expect(lead.commands.get("team-close").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await realRead(team, "peer"))?.activity).not.toBe("stopped");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
  }, 10_000);

  it("an unsupported terminal refuses a peer that is live only on the final read", async () => {
    const { lead } = await attachBoth();
    terminalState.adapter.name = "windows";
    const realRead = runtime.readRuntimeStatus.bind(runtime);
    let peerReads = 0;
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (teamName, agent) => {
      const status = await realRead(teamName, agent);
      if (agent !== "peer" || !status) return status;
      peerReads += 1;
      if (peerReads < 3) return { ...status, activity: "stopped", pid: undefined };
      return status;
    });
    await expect(lead.commands.get("team-close").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect((await realRead(team, "peer"))?.activity).not.toBe("stopped");

    peerReads = 0;
    terminalState.adapter.name = "zellij";
    await expect(lead.commands.get("team-shutdown").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect((await realRead(team, "peer"))?.activity).not.toBe("stopped");
  }, 10_000);

  it("an unsupported terminal refuses a pending launch that appears after the first look", async () => {
    const { lead } = await attachBoth();
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: undefined, processStartToken: undefined });
    await teams.updateMember(team, "peer", {
      tmuxPaneId: "",
      windowId: "win-late",
      recovery: { token: "late-window", ownerInstanceId: "restore-owner", phase: "launched" },
    });
    const realRead = teams.readConfig.bind(teams);
    vi.spyOn(teams, "readConfig").mockImplementation(async (name) => {
      const config = await realRead(name);
      return {
        ...config,
        members: config.members.map(member => member.name === "peer" && member.recovery
          ? { ...member, windowId: undefined, recovery: { ...member.recovery, phase: "attached" as const } }
          : member),
      };
    });
    terminalState.adapter.name = "zellij";
    await expect(lead.commands.get("team-shutdown").handler("", lead.ctx)).rejects.toThrow("cannot close teammate panes");
    expect(terminalState.adapter.killWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    const phase = JSON.parse(fs.readFileSync(paths.configPath(team), "utf8")).members
      .find((member: { name: string }) => member.name === "peer").recovery.phase;
    expect(phase).toBe("launched");
  }, 10_000);

  it("an already stopped team can still be dissolved when the terminal cannot close panes", async () => {
    const { lead } = await attachBoth();
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: undefined, processStartToken: undefined });
    terminalState.adapter.name = "windows";
    await lead.commands.get("team-shutdown").handler("", lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(terminalState.adapter.killWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("teammates cannot close or shut down a team", async () => {
    const { peer } = await attachBoth();
    await expect(peer.commands.get("team-close").handler("", peer.ctx))
      .rejects.toThrow("Only the team lead can close team panes");
    await expect(peer.commands.get("team-shutdown").handler("", peer.ctx))
      .rejects.toThrow("Only the team lead can shut down an entire team");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
  }, 10_000);
});
