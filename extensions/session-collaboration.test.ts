import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import * as messaging from "../src/utils/messaging";
import * as predefined from "../src/utils/predefined-teams";
import { allocateSession, findSessionMember } from "../src/utils/team-session";
import { readQuiescenceState } from "../src/utils/quiescence";
import type { TeamSession } from "../src/utils/models";

const terminalState = vi.hoisted(() => ({ adapter: null as any }));
vi.mock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => terminalState.adapter }));
let root: string;
const loaded: any[] = [];
const panes = new Set<string>();
let paneNumber = 0;
function make(identity: TeamSession) {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const ctx: any = { sessionManager: SessionManager.open(identity.file), cwd: root, isIdle: () => true,
    shutdown: vi.fn(), ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } };
  extension({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: vi.fn() } as any);
  const result = { ctx, tools, commands,
    emit: (name: string, event: any = {}) => handlers.get(name)({ type: name, ...event }, ctx),
    call: (name: string, args: any = {}) => tools.get(name).execute(name, args, undefined, undefined, ctx) };
  loaded.push(result);
  return result;
}
async function start(identity = allocateSession("placeholder", root)) {
  const lead = make(identity);
  await lead.emit("session_start", { reason: "startup" });
  return { lead, identity };
}
async function delegate(lead: any, name = "A") {
  return lead.call("delegate_task", { teammate_name: name, cwd: root,
    task_subject: `Work for ${name}`, task_description: "test assignment" });
}
async function attachedPeer(team: string, name: string) {
  const member = (await teams.readConfig(team)).members.find(m => m.name === name)!;
  const peer = make(member.session!);
  await peer.emit("session_start", { reason: "startup" });
  // These extension fixtures share the runner PID; never signal it on close.
  fs.rmSync(path.join(paths.teamDir(team), `${name}.pid`), { force: true });
  return peer;
}
async function settle() { for (let i = 0; i < 120; i++) await Promise.resolve(); }

beforeEach(() => {
  // Lock contention uses real setTimeout; only interval polling is controlled.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-collab-"));
  panes.clear(); paneNumber = 0;
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(root, "sessions"));
  for (const key of ["PI_TEAM_NAME", "PI_AGENT_NAME", "PI_TEAM_HANDOFF_TOKEN", "PI_TEAM_RECOVERY_TOKEN", "TMUX_PANE", "TMUX"]) vi.stubEnv(key, undefined);
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockImplementation(() => {
    const dir = path.join(root, "teams");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  });
  terminalState.adapter = { name: "tmux", supportsWindows: () => false, findRecoveryPane: () => undefined,
    spawn: vi.fn(() => { const pane = `%test-${++paneNumber}`; panes.add(pane); return pane; }),
    kill: vi.fn((pane: string) => { panes.delete(pane); return "closed"; }),
    killWindow: vi.fn(), isAlive: (pane: string) => panes.has(pane), isWindowAlive: () => false, setTitle: vi.fn() };
});
afterEach(async () => {
  for (const target of loaded.splice(0)) await target.emit("session_shutdown", { reason: "quit" }).catch(() => {});
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("main-session collaboration", () => {
  it("creates nothing on startup/status and starts collaboration on the first unnamed dispatch", async () => {
    const { lead, identity } = await start();
    expect(paths.listTeamNames()).toEqual([]);
    await expect(lead.call("team_status")).rejects.toThrow("No active collaboration");
    expect(paths.listTeamNames()).toEqual([]);
    const result = await delegate(lead);
    const saved = findSessionMember(identity)!;
    expect(saved.member.name).toBe("team-lead");
    expect((await teams.readConfig(saved.teamName)).internal).toBe(true);
    expect(result.details.task.owner).toBe("A");
    expect(terminalState.adapter.spawn).toHaveBeenCalledOnce();
    expect((await readQuiescenceState(saved.teamName)).generation).toBe(1);
    expect((await lead.call("task_list")).details.tasks).toHaveLength(1);
    expect(lead.tools.get("team_create").exposure).toBe("hidden");
    expect(lead.tools.get("list_runtime_teams").exposure).toBe("hidden");
    for (const name of ["delegate_task", "create_predefined_team", "team_wait", "team_message", "team_status", "task_list", "team_resume", "team_close"]) {
      expect(lead.tools.get(name).parameters.required ?? []).not.toContain("team_name");
    }
  });

  it("isolates two main sessions in the same directory and rejects foreign legacy names", async () => {
    const first = await start(); await delegate(first.lead);
    const firstTeam = findSessionMember(first.identity)!.teamName;
    const second = await start();
    await expect(second.lead.call("task_list", { team_name: firstTeam })).rejects.toThrow("No collaboration is attached");
    await delegate(second.lead, "B");
    const secondTeam = findSessionMember(second.identity)!.teamName;
    expect(secondTeam).not.toBe(firstTeam);
    await expect(second.lead.call("team_message", { team_name: firstTeam, to: "A", content: "foreign" }))
      .rejects.toThrow("cannot select another team");
    expect((await first.lead.call("task_list")).details.tasks[0].owner).toBe("A");
    expect((await second.lead.call("task_list")).details.tasks[0].owner).toBe("B");
  });

  it("serializes simultaneous first dispatches into one collaboration", async () => {
    const { lead, identity } = await start();
    await Promise.all([delegate(lead, "A"), delegate(lead, "B")]);
    const team = findSessionMember(identity)!.teamName;
    expect(paths.listTeamNames()).toEqual([team]);
    expect((await teams.readConfig(team)).members.map(m => m.name).sort()).toEqual(["A", "B", "team-lead"]);
  });
});

describe("dispatch and recovery review regressions", () => {
  function template() {
    vi.spyOn(predefined, "getPredefinedTeam").mockReturnValue({ name: "sample", agents: ["helper"], source: "project" } as any);
    vi.spyOn(predefined, "getAllAgentDefinitions").mockReturnValue([
      { name: "helper", prompt: "Review independently", source: "project" } as any,
    ]);
  }

  it("launches a template from the main session without a team name", async () => {
    template();
    const { lead, identity } = await start();
    const result = await lead.call("create_predefined_team", { predefined_team: "sample", cwd: root });
    expect(result.details.results[0].status).toBe("spawned");
    expect(findSessionMember(identity)?.member.name).toBe("team-lead");
    expect(terminalState.adapter.spawn).toHaveBeenCalledOnce();
  });

  it("refuses a teammate's template launch before any roster/inbox mutation", async () => {
    template();
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    const peer = await attachedPeer(team, "A");
    const before = fs.readFileSync(paths.configPath(team), "utf8");
    terminalState.adapter.spawn.mockClear();
    await expect(peer.call("create_predefined_team", { predefined_team: "sample", cwd: root })).rejects.toThrow("Only the team lead");
    expect(fs.readFileSync(paths.configPath(team), "utf8")).toBe(before);
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
    expect(await messaging.readInbox(team, "helper", true, false)).toEqual([]);
  });

  it("refuses a stale main instance's template launch", async () => {
    template();
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    const old = await runtime.readRuntimeStatus(team, "team-lead");
    await runtime.replaceRuntimeInstance(team, "team-lead", old!.instanceId, "new-owner", {});
    terminalState.adapter.spawn.mockClear();
    await expect(lead.call("create_predefined_team", { predefined_team: "sample", cwd: root })).rejects.toThrow("Only the live lead");
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
  });

  it("does not establish collaboration for an invalid template", async () => {
    vi.spyOn(predefined, "getPredefinedTeam").mockReturnValue(undefined);
    vi.spyOn(predefined, "getAllPredefinedTeams").mockReturnValue([]);
    const { lead } = await start();
    await expect(lead.call("create_predefined_team", { predefined_team: "absent", cwd: root })).rejects.toThrow("not found");
    expect(paths.listTeamNames()).toEqual([]);
  });

  it("recovers an older partial internal create without guessing another session", async () => {
    const identity = allocateSession("placeholder", root);
    const team = `session-${identity.id}`;
    await teams.createTeam(team, identity.id, "lead", "partial", undefined, undefined, true);
    expect((await teams.readConfig(team)).members[0].session).toBeUndefined();
    const { lead } = await start(identity);
    await delegate(lead);
    expect(paths.listTeamNames()).toEqual([team]);
    expect(findSessionMember(identity)?.teamName).toBe(team);
    expect((await teams.readConfig(team)).members[0].session).toMatchObject({ id: identity.id, file: identity.file });
  });

  it("atomically retains the main binding if post-create attachment fails, then retries", async () => {
    const { lead, identity } = await start();
    vi.spyOn(teams, "updateMember").mockRejectedValueOnce(new Error("attachment I/O failure"));
    await expect(delegate(lead)).rejects.toThrow("attachment I/O failure");
    expect(findSessionMember(identity)?.member.session?.file).toBe(identity.file);
    await delegate(lead);
    expect(paths.listTeamNames()).toHaveLength(1);
  });

  it("does not retarget a moved original session file and reports its actual recorded path", async () => {
    const first = await start(); await delegate(first.lead);
    await first.lead.emit("session_shutdown", { reason: "quit" });
    const moved = path.join(root, "moved.jsonl");
    fs.copyFileSync(first.identity.file, moved);
    const other = await start({ ...first.identity, file: moved });
    await expect(delegate(other.lead)).rejects.toThrow(first.identity.file);
    expect(findSessionMember(first.identity)?.member.session?.file).toBe(first.identity.file);
  });

  it("keeps a hidden pane hidden when its original process still lives; explicit reopen reports blocked", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const original = (await teams.readConfig(team)).members.find(m => m.name === "A")!;
    panes.delete(original.tmuxPaneId);
    await teams.setWindowIntent(team, "A", "closed", "pane-missing");
    const before = (await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent;
    terminalState.adapter.spawn.mockClear();
    const resume = await lead.call("team_resume", { agent_name: "A" });
    expect(resume.details.recovery[0].status).toBe("blocked");
    expect(resume.details.recovery[0].note).toContain("still alive");
    const assignment = await delegate(lead);
    expect(assignment.details.restoreOutcome.status).toBe("blocked");
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent).toEqual(before);
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
  });

  it("does not classify a foreign adapter's window ID as a missing tmux pane", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    await teams.updateMember(team, "A", { tmuxPaneId: "", windowId: "wezterm_window_123" });
    await lead.call("team_close");
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state ?? "open").toBe("open");
  });
});

describe("durable pane intent", () => {
  it("keeps an individually closed member hidden on lead recovery and explicitly resumes the original conversation", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const original = (await teams.readConfig(team)).members.find(m => m.name === "A")!.session!;
    await lead.call("team_close", { agent_name: "A" });
    await runtime.setRuntimeActivity(team, "A", "stopped", { pid: 99999999, processStartToken: undefined });
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state).toBe("closed");
    expect(lead.ctx.shutdown).not.toHaveBeenCalled();
    await lead.emit("session_shutdown", { reason: "quit" });
    terminalState.adapter.spawn.mockClear();
    const resumed = await start(identity);
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
    await resumed.lead.call("team_message", { to: "A", content: "leave unread" });
    await resumed.lead.call("team_status");
    expect(terminalState.adapter.spawn).not.toHaveBeenCalled();
    await resumed.lead.commands.get("team-resume").handler("A", resumed.lead.ctx);
    expect(terminalState.adapter.spawn).toHaveBeenCalledOnce();
    const options = terminalState.adapter.spawn.mock.calls[0][0];
    expect(options.command).toContain(original.file);
    expect(options.command).not.toMatch(/--model|--thinking/);
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.session).toEqual(original);
    expect((await messaging.readInbox(team, "A", true, false)).some(m => m.text === "leave unread")).toBe(true);
    expect((await readQuiescenceState(team)).generation).toBe(1);
  });

  it("reopens an individually closed member on new delegation, never allocates a replacement conversation", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const original = (await teams.readConfig(team)).members.find(m => m.name === "A")!.session!;
    await lead.commands.get("team-close").handler("A", lead.ctx);
    await runtime.setRuntimeActivity(team, "A", "stopped", { pid: 99999999, processStartToken: undefined });
    terminalState.adapter.spawn.mockClear();
    const result = await delegate(lead);
    expect(result.details.restoreOutcome.status).toBe("restored");
    expect(terminalState.adapter.spawn.mock.calls[0][0].command).toContain(original.file);
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state).toBe("open");
    expect((await readQuiescenceState(team)).generation).toBe(2);
  });

  it("whole close snapshots an immediately missing A, preserves open B, then recovers only B", async () => {
    const { lead, identity } = await start(); await delegate(lead, "A"); await delegate(lead, "B");
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A"); await attachedPeer(team, "B");
    const members = (await teams.readConfig(team)).members;
    const a = members.find(m => m.name === "A")!;
    const b = members.find(m => m.name === "B")!;
    panes.delete(a.tmuxPaneId); // Manual tmux close, before the next poll tick.
    await lead.commands.get("team-close").handler("", lead.ctx);
    const saved = (await teams.readConfig(team)).members;
    expect(saved.find(m => m.name === "A")!.windowIntent?.state).toBe("closed");
    expect(saved.find(m => m.name === "B")!.windowIntent?.state ?? "open").toBe("open");
    await vi.advanceTimersByTimeAsync(1000); // Our own closure must not hide B.
    await settle();
    expect((await teams.readConfig(team)).members.find(m => m.name === "B")!.windowIntent?.state ?? "open").toBe("open");
    await lead.emit("session_shutdown", { reason: "quit" });
    for (const name of ["A", "B"]) await runtime.setRuntimeActivity(team, name, "stopped", { pid: 99999999, processStartToken: undefined });
    terminalState.adapter.spawn.mockClear();
    await start(identity);
    expect(terminalState.adapter.spawn).toHaveBeenCalledOnce();
    expect(terminalState.adapter.spawn.mock.calls[0][0].command).toContain(b.session!.file);
  });

  it("observes manual pane loss while the lead lives, without removing membership or completing tasks", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const member = (await teams.readConfig(team)).members.find(m => m.name === "A")!;
    panes.delete(member.tmuxPaneId);
    await vi.advanceTimersByTimeAsync(1000); await settle();
    await vi.waitFor(async () => {
      expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state).toBe("closed");
    }, { timeout: 2000, interval: 20 });
    expect((await lead.call("task_list")).details.tasks[0].status).toBe("in_progress");
    expect((await teams.readConfig(team)).members).toHaveLength(2);
  });

  it("does not persist unknown tmux query failure as a hidden pane", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const a = (await teams.readConfig(team)).members.find(m => m.name === "A")!;
    panes.delete(a.tmuxPaneId);
    let queryFailed = true;
    terminalState.adapter.panePresence = vi.fn((id: string) => queryFailed ? "unknown" : panes.has(id) ? "present" : "missing");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(terminalState.adapter.panePresence).toHaveBeenCalled());
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent).toBeUndefined();
    queryFailed = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state).toBe("closed"));
  });

  it("does not infer a member-specific close when the lead anchor is also missing", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    await attachedPeer(team, "A");
    const a = (await teams.readConfig(team)).members.find(m => m.name === "A")!;
    panes.delete(a.tmuxPaneId);
    vi.stubEnv("TMUX_PANE", "%lead");
    terminalState.adapter.panePresence = vi.fn((id: string) => panes.has(id) ? "present" : "missing");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(terminalState.adapter.panePresence).toHaveBeenCalledWith("%lead"));
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent).toBeUndefined();
    panes.add("%lead");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state).toBe("closed"));
  });

  it("retains open intent across collective exit rather than treating offline losses as individual hiding", async () => {
    const { lead, identity } = await start(); await delegate(lead);
    const team = findSessionMember(identity)!.teamName;
    const peer = await attachedPeer(team, "A");
    await lead.emit("session_shutdown", { reason: "quit" });
    await peer.emit("session_shutdown", { reason: "quit" });
    panes.clear();
    terminalState.adapter.spawn.mockClear();
    await start(identity);
    expect(terminalState.adapter.spawn).toHaveBeenCalledOnce();
    expect((await teams.readConfig(team)).members.find(m => m.name === "A")!.windowIntent?.state ?? "open").toBe("open");
  });
});
