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
import * as messaging from "../src/utils/messaging";
import * as terminalAdapter from "../src/utils/terminal-adapter";
import { TmuxAdapter } from "../src/adapters/tmux-adapter";

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
    reload: vi.fn(async () => {}), shutdown: vi.fn(() => { object.stopping = true; }), ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } };
  extension({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text) } as any);
  const object: any = { handlers, tools, commands, sent, ctx, stopping: false, setIdle: (value: boolean) => { idle = value; },
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
    // The lead pane is not closed; its Pi is requested to exit after teammates close.
    expect(terminalState.adapter.kill).not.toHaveBeenCalledWith(expect.stringContaining("lead"));
    expect(lead.ctx.shutdown).toHaveBeenCalledOnce();
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("peer: closed");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("data preserved");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("exit to its shell");
  }, 10_000);

  it("/team-close reports an already stopped teammate without killing its pane again", async () => {
    const { lead } = await attachBoth();
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: 99999999, processStartToken: undefined });
    await lead.commands.get("team-close").handler(team, lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("peer: not running");
    expect(lead.ctx.shutdown).toHaveBeenCalledOnce();
  }, 10_000);

  it("/team-shutdown closes panes, deletes team data, and preserves Pi history", async () => {
    const { lead } = await attachBoth();
    fs.mkdirSync(paths.taskDir(team), { recursive: true });
    fs.writeFileSync(path.join(paths.taskDir(team), "1.json"), '{"id":"1","status":"in_progress","owner":"peer"}');
    const before = fs.readFileSync(peerIdentity.file);
    await lead.commands.get("team-shutdown").handler("confirm", lead.ctx);
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
    await lead.commands.get("team-shutdown").handler(`${team} confirm`, lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("an unattached session cannot close or shut down a team by name", async () => {
    await attachBoth();
    const stranger = make(allocateSession(team, root));
    await stranger.emit("session_start", { reason: "startup" });
    await expect(stranger.commands.get("team-close").handler(team, stranger.ctx)).rejects.toThrow("live lead");
    await expect(stranger.commands.get("team-shutdown").handler(`${team} confirm`, stranger.ctx))
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
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("Lead Pi will not exit");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).not.toContain("Lead Pi will exit to its shell");
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).not.toContain("peer: closed");
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
  }, 10_000);

  it("confirmed shutdown does not delete the team when a pane lease changes", async () => {
    const { lead } = await attachBoth();
    vi.spyOn(runtime, "replaceRuntimeInstance").mockResolvedValue(null);
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("was not deleted");
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("lease changed");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect(fs.existsSync(paths.teamDir(team))).toBe(true);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    expect(lead.ctx.ui.setStatus).not.toHaveBeenCalledWith("pi-teams", undefined);
  }, 10_000);

  it("a refused tmux pane close does not exit the lead, delete the team, or leave the member stopped", async () => {
    const { lead } = await attachBoth();
    const before = await runtime.readRuntimeStatus(team, "peer");
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({ stdout: "", stderr: "kill-pane refused", status: 1 });
    const tmux = new TmuxAdapter();
    terminalState.adapter.kill = (paneId: string) => tmux.kill(paneId);
    await lead.commands.get("team-close").handler("", lead.ctx);
    const notice = lead.ctx.ui.notify.mock.calls.at(-1)[0] as string;
    expect(notice).toContain("peer: close failed");
    expect(notice).toContain("terminal close failed");
    expect(notice).toContain("Lead Pi will not exit");
    expect(notice).not.toContain("Lead Pi will exit to its shell");
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    const after = await runtime.readRuntimeStatus(team, "peer");
    expect(after?.activity).toBe(before?.activity);
    expect(after?.instanceId).toBe(before?.instanceId);
    expect(fs.existsSync(paths.configPath(team))).toBe(true);

    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("close failed");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect(fs.existsSync(paths.teamDir(team))).toBe(true);
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).toBe(before?.activity);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.instanceId).toBe(before?.instanceId);
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
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("cannot close teammate panes");
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
    await lead.commands.get("team-shutdown").handler("confirm", lead.ctx);
    expect(terminalState.adapter.killWindow).toHaveBeenCalledWith("win-shutdown");
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("/team-shutdown confirm closes a pending separate window before deleting the team", async () => {
    const { lead } = await attachBoth();
    await seedWindowOnlyLaunch("win-tool");
    await lead.commands.get("team-shutdown").handler("confirm", lead.ctx);
    expect(terminalState.adapter.killWindow).toHaveBeenCalledWith("win-tool");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
  }, 10_000);

  it("a refused window close does not delete the team or forget the pending launch", async () => {
    const { lead } = await attachBoth();
    await seedWindowOnlyLaunch("win-refused");
    terminalState.adapter.killWindow.mockReturnValue("failed");
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("close failed");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")?.recovery?.phase).toBe("launched");
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    expect(lead.ctx.ui.setStatus).not.toHaveBeenCalledWith("pi-teams", undefined);
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

    const closed = await lead.tools.get("team_close").execute("x", {
      team_name: team, agent_name: "peer",
    }, undefined, undefined, lead.ctx);
    expect(closed.content[0].text).toContain("lease changed");
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")).toBeTruthy();
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).not.toBe("stopped");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
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
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("live lead");
    await expect(lead.tools.get("team_close").execute("x", { team_name: team }, undefined, undefined, lead.ctx))
      .rejects.toThrow("live lead");
    expect(lead.tools.get("team_shutdown")).toBeUndefined();
    expect(lead.tools.get("process_shutdown_approved")).toBeUndefined();
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
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("cannot close teammate panes");
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
    await expect(lead.commands.get("team-shutdown").handler("confirm", lead.ctx)).rejects.toThrow("cannot close teammate panes");
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
    await lead.commands.get("team-shutdown").handler("confirm", lead.ctx);
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(terminalState.adapter.killWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(peerIdentity.file)).toBe(true);
  }, 10_000);

  it("teammates cannot close or shut down a team", async () => {
    const { peer } = await attachBoth();
    await expect(peer.commands.get("team-close").handler("", peer.ctx))
      .rejects.toThrow("Only the team lead can close team panes");
    await expect(peer.commands.get("team-shutdown").handler("confirm", peer.ctx))
      .rejects.toThrow("Only the team lead can shut down an entire team");
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
  }, 10_000);

  function rosterNotices(): string[] {
    const file = paths.inboxPath(team, "team-lead");
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"))
      .map((message: { text?: string }) => message.text ?? "")
      .filter((text: string) => text.includes("roster"));
  }

  it("/team-close <member> closes that pane and leaves the lead attached", async () => {
    const { lead } = await attachBoth();
    await lead.commands.get("team-close").handler("peer", lead.ctx);
    expect(terminalState.adapter.kill).toHaveBeenCalledWith("%peer");
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")).toBeTruthy();
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("lead stays attached");
  }, 10_000);

  it("refuses to delete a team without the confirm word", async () => {
    const { lead } = await attachBoth();
    await expect(lead.commands.get("team-shutdown").handler("", lead.ctx)).rejects.toThrow("confirm");
    await expect(lead.commands.get("team-shutdown").handler(team, lead.ctx)).rejects.toThrow("confirm");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.configPath(team))).toBe(true);
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
  }, 10_000);

  it("prepares the terminal before SIGKILL when the process identity is confirmed", async () => {
    const { lead } = await attachBoth();
    const current = (await runtime.readRuntimeStatus(team, "peer"))!;
    await runtime.setRuntimeActivity(team, "peer", "idle", {
      pid: 424242, processStartToken: "token-424242", instanceId: current.instanceId,
      sessionId: current.sessionId, sessionFile: current.sessionFile,
    });
    fs.writeFileSync(path.join(paths.teamDir(team), "peer.pid"), "424242");
    vi.spyOn(runtime, "hasConfirmedProcessIdentity").mockReturnValue(true);
    const prepare = vi.fn();
    terminalState.adapter.prepareShutdown = prepare;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await lead.commands.get("team-close").handler("peer", lead.ctx);
    const killOrder = kill.mock.invocationCallOrder.find((_, index) => kill.mock.calls[index]?.[1] === "SIGKILL");
    expect(kill).toHaveBeenCalledWith(424242, "SIGKILL");
    expect(prepare).toHaveBeenCalledWith("%peer");
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(killOrder!);
    expect(terminalState.adapter.kill).toHaveBeenCalledWith("%peer");
  }, 10_000);

  it("a marker error does not kill the pane or send SIGKILL", async () => {
    const { lead } = await attachBoth();
    const current = (await runtime.readRuntimeStatus(team, "peer"))!;
    await runtime.setRuntimeActivity(team, "peer", "idle", {
      pid: 424242, processStartToken: "token-424242", instanceId: current.instanceId,
      sessionId: current.sessionId, sessionFile: current.sessionFile,
    });
    fs.writeFileSync(path.join(paths.teamDir(team), "peer.pid"), "424242");
    vi.spyOn(runtime, "hasConfirmedProcessIdentity").mockReturnValue(true);
    terminalState.adapter.prepareShutdown = vi.fn(() => { throw new Error("marker denied"); });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(lead.commands.get("team-close").handler("peer", lead.ctx)).rejects.toThrow("marker denied");
    expect(kill).not.toHaveBeenCalledWith(424242, "SIGKILL");
    expect(terminalState.adapter.kill).not.toHaveBeenCalled();
  }, 10_000);

  it("/team-resume reopens one named original session and not a new member", async () => {
    const { lead } = await attachBoth();
    const current = (await runtime.readRuntimeStatus(team, "peer"))!;
    await runtime.setRuntimeActivity(team, "peer", "stopped", {
      detached: true, pid: 99999999, processStartToken: undefined, instanceId: current.instanceId,
    });
    terminalState.adapter.spawn.mockClear();
    terminalState.adapter.isAlive = () => false;
    await lead.commands.get("team-resume").handler(`${team} peer`, lead.ctx);
    expect(terminalState.adapter.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(terminalState.adapter.spawn.mock.calls)).toContain(peerIdentity.file);
    expect((await teams.readConfig(team)).members.filter(member => member.name === "peer")).toHaveLength(1);
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
  }, 10_000);

  it("reports one inbox notice when a teammate stops outside a close command", async () => {
    await attachBoth();
    const current = (await runtime.readRuntimeStatus(team, "peer"))!;
    await runtime.setRuntimeActivity(team, "peer", "stopped", {
      detached: true, pid: 99999999, processStartToken: undefined, instanceId: current.instanceId,
    });
    for (let i = 0; i < 40 && rosterNotices().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(rosterNotices()).toHaveLength(1);
    expect(rosterNotices()[0]).toContain("not restarted");
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(rosterNotices()).toHaveLength(1);
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")).toBeTruthy();
  }, 10_000);

  it("a commanded close does not also send an unexpected-stop notice", async () => {
    const { lead } = await attachBoth();
    await lead.commands.get("team-close").handler("peer", lead.ctx);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(rosterNotices()).toHaveLength(0);
    expect((await teams.readConfig(team)).members).toHaveLength(2);
  }, 10_000);

  it("reports a missing pane while the process is still alive", async () => {
    await attachBoth();
    terminalState.adapter.isAlive = () => false;
    for (let i = 0; i < 40 && rosterNotices().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(rosterNotices()).toHaveLength(1);
    expect(rosterNotices()[0]).toContain("pane is missing");
    expect(rosterNotices()[0]).not.toContain("stopped and its pane");
  }, 10_000);

  it("a failed later stop notice does not resend an earlier one", async () => {
    await attachBoth();
    const peer = (await runtime.readRuntimeStatus(team, "peer"))!;
    await teams.addMember(team, {
      name: "other", agentId: "other@close", agentType: "teammate", joinedAt: 1,
      tmuxPaneId: "%other", cwd: root, subscriptions: [],
    });
    let refused = false;
    const real = messaging.appendMessageOnce;
    vi.spyOn(messaging, "appendMessageOnce").mockImplementation(async (name, agent, message, commit) => {
      if (!refused && message.id === "stop:other-instance") {
        refused = true;
        throw new Error("inbox write failed");
      }
      return real(name, agent, message, commit);
    });
    await runtime.setRuntimeActivity(team, "peer", "stopped", {
      detached: true, pid: 99999999, processStartToken: undefined, instanceId: peer.instanceId,
    });
    await runtime.setRuntimeActivity(team, "other", "stopped", {
      detached: true, pid: 99999998, processStartToken: undefined, instanceId: "other-instance",
    });
    const count = (name: string) => rosterNotices().filter(text => text.startsWith(`${name} `)).length;
    for (let i = 0; i < 50 && (count("peer") < 1 || count("other") < 1); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(refused).toBe(true);
    expect(count("peer")).toBe(1);
    expect(count("other")).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(count("peer")).toBe(1);
    expect(count("other")).toBe(1);
    const messages = JSON.parse(fs.readFileSync(paths.inboxPath(team, "team-lead"), "utf8")) as { id: string }[];
    expect(messages.filter(message => message.id === `stop:${peer.instanceId}`)).toHaveLength(1);
    expect(messages.filter(message => message.id === "stop:other-instance")).toHaveLength(1);
  }, 10_000);

  it("an in-flight stop notice does not recreate a deleted team", async () => {
    const { lead } = await attachBoth();
    const instanceId = (await runtime.readRuntimeStatus(team, "peer"))!.instanceId!;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let entered = false;
    let wroteStopNotice = false;
    let appendError: unknown = null;
    const real = messaging.appendMessageOnce;
    vi.spyOn(messaging, "appendMessageOnce").mockImplementation(async (name, agent, message, commit) => {
      if (message.id !== `stop:${instanceId}`) return real(name, agent, message, commit);
      entered = true;
      await gate;
      let stored: Awaited<ReturnType<typeof real>> | null = null;
      try {
        stored = await real(name, agent, message, commit);
      } catch (error) {
        appendError = error;
        throw error;
      }
      const file = paths.inboxPath(team, "team-lead");
      if (fs.existsSync(file)) {
        const msgs = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: string }[];
        wroteStopNotice = msgs.some(item => item.id === `stop:${instanceId}`);
      }
      return stored;
    });
    await runtime.setRuntimeActivity(team, "peer", "stopped", {
      detached: true, pid: 99999997, processStartToken: undefined, instanceId,
    });
    for (let i = 0; i < 50 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(entered).toBe(true);
    const clears = () => lead.ctx.ui.setStatus.mock.calls.filter((call: unknown[]) => call[0] === "pi-teams" && call[1] === undefined).length;
    const beforeClears = clears();
    const pending = lead.commands.get("team-shutdown").handler("confirm", lead.ctx);
    for (let i = 0; i < 50 && clears() === beforeClears; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(clears()).toBeGreaterThan(beforeClears);
    releaseGate();
    await pending;
    expect(appendError).toBeNull();
    expect(wroteStopNotice).toBe(false);
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(team, "team-lead"))).toBe(false);
  }, 10_000);
});
