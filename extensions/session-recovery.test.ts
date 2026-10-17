import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import * as messaging from "../src/utils/messaging";
import { allocateSession, findSessionMember } from "../src/utils/team-session";
import type { TeamSession } from "../src/utils/models";

const terminalState = vi.hoisted(() => ({ adapter: null as any }));
vi.mock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => terminalState.adapter }));
let root: string;
let leadIdentity: TeamSession;
let peerIdentity: TeamSession;
const team = "sdk-recovery";
const loaded: any[] = [];
const actualSessions: any[] = [];
const processToken = runtime.getProcessStartToken(process.pid);
const paneSpawns: any[] = [];
function terminal() { return { name: "tmux", setTitle() {}, supportsWindows: () => false,
  spawn: (options: any) => { paneSpawns.push(options); return "%restored"; }, findRecoveryPane: () => undefined,
  kill() {}, killWindow() {}, isAlive: () => false, isWindowAlive: () => false }; }
function make(identity: TeamSession, envTeam?: string, envAgent?: string, handoff?: string) {
  vi.stubEnv("PI_TEAM_NAME", envTeam); vi.stubEnv("PI_AGENT_NAME", envAgent);
  vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", handoff);
  const handlers = new Map<string, any>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const sent: string[] = [];
  const ctx: any = { sessionManager: SessionManager.open(identity.file), isIdle: () => true,
    cwd: root, shutdown: vi.fn(), ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } };
  extension({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text) } as any);
  const object = { handlers, tools, commands, sent, ctx, emit: (name: string, event: any = {}) => handlers.get(name)({ type: name, ...event }, ctx) };
  loaded.push(object); return object;
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
async function mail(agent = "team-lead") { return messaging.appendMessage(team, agent,
  { from: "human", text: "explicit mail only", timestamp: new Date(0).toISOString(), read: false }); }
function fakeSuccess(session: any) {
  session.agent.streamFunction = async (model: any) => {
    const stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "fake provider success" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  };
}
async function sdk(manager: SessionManager, reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup") {
  const agentDir = path.join(root, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  await modelRuntime.setRuntimeApiKey("openai", "fake-test-no-network");
  const events: any[] = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [extension, (pi) => {
      pi.on("session_start", event => { events.push(event); });
      pi.on("agent_settled", event => { events.push(event); });
    }] });
  await loader.reload();
  const saved = manager.buildSessionContext();
  const result = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader,
    sessionManager: manager, model: saved.model ? undefined : getModel("openai", "gpt-4o-mini"),
    thinkingLevel: saved.model ? undefined : "off",
    settingsManager, tools: [], sessionStartEvent: { type: "session_start", reason } });
  actualSessions.push(result.session);
  fakeSuccess(result.session);
  await result.session.bindExtensions({ onError: error => { throw new Error(String(error)); } });
  return { ...result, events };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-session-extension-")); paneSpawns.length = 0;
  terminalState.adapter = terminal();
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockReturnValue([team]);
  vi.stubEnv("PI_TEAM_NAME", undefined); vi.stubEnv("PI_AGENT_NAME", undefined); vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", undefined);
  await teams.createTeam(team, "legacy", "lead");
  leadIdentity = allocateSession(team, root); peerIdentity = allocateSession(team, root);
  await teams.updateMember(team, "team-lead", { session: leadIdentity });
  await teams.addMember(team, { name: "peer", agentId: "peer@recovery", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%old", cwd: root, subscriptions: [], session: { ...peerIdentity, confirmed: true } });
});
afterEach(async () => {
  for (const target of loaded.splice(0)) await target.emit("session_shutdown").catch(() => {});
  for (const session of actualSessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
    session.dispose();
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});

describe("session attachment and restoration lifecycle", () => {
  it("resumes the original lead without env after dead PID, restores missing pane, and reads mail", async () => {
    await runtime.setRuntimeActivity(team, "team-lead", "running", { pid: 99999999, instanceId: "crashed" });
    await mail(); const lead = make(leadIdentity); await lead.emit("session_start", { reason: "startup" }); await drain();
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.pid).toBe(process.pid);
    expect(lead.sent.join("\n")).toContain("explicit mail only");
    expect(paneSpawns).toHaveLength(1); expect(paneSpawns[0].command).toContain(peerIdentity.file);
    expect(paneSpawns[0].command).not.toMatch(/--model|--thinking/);
  });

  it("keeps a live lead and peers without duplicate reader or pane", async () => {
    await runtime.setRuntimeActivity(team, "peer", "idle", { pid: process.pid, processStartToken: processToken, instanceId: "peer" });
    const first = make(leadIdentity); await first.emit("session_start");
    const second = make(leadIdentity); await second.emit("session_start");
    await mail(); await drain();
    expect(paneSpawns).toHaveLength(0);
    expect(second.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("another live process");
    expect(second.sent).toEqual([]);
  });

  it("same member session resumes without env and keeps an interrupted pause across quit", async () => {
    const peer = make(peerIdentity); await peer.emit("session_start"); await peer.emit("agent_start");
    await peer.emit("agent_settled", { aborted: true }); await peer.emit("session_shutdown", { reason: "quit" });
    await mail("peer"); const resumed = make(peerIdentity); await resumed.emit("session_start"); await drain();
    const status = await runtime.readRuntimeStatus(team, "peer");
    expect(status).toMatchObject({ activity: "interrupted", paused: true, sessionId: peerIdentity.id });
    expect(resumed.sent).toEqual([]);
    expect((await messaging.readInbox(team, "peer", true, false))).toHaveLength(1);
  });

  it("new/fork/clone sessions cannot inherit via same PID, lingering env, or copied custom entries", async () => {
    const lead = make(leadIdentity, team, "team-lead"); await lead.emit("session_start");
    const original = lead.ctx.sessionManager as SessionManager;
    original.appendCustomEntry("pi-teams", { teamName: team, role: "team-lead" });
    original.appendMessage({ role: "user", content: "fixture for fork", timestamp: Date.now() });
    // Pi defers the session body until an assistant entry; force real framing
    // here so forkFrom actually copies the custom entry, not just a header.
    original.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture response" }],
      api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const fork = SessionManager.forkFrom(leadIdentity.file, root, path.join(root, "fork"));
    expect(fork.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-teams")).toBe(true);
    lead.ctx.sessionManager = fork;
    await lead.emit("session_start", { reason: "fork" }); await mail(); await drain();
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.detached).toBe(true);
    expect(lead.sent).toEqual([]);
    await expect(lead.tools.get("team_wait").execute("wait", { team_name: team }, new AbortController().signal, undefined, lead.ctx))
      .rejects.toThrow("bound to team none");
    const fresh = SessionManager.create(root, path.join(root, "new")); lead.ctx.sessionManager = fresh;
    await lead.emit("session_start", { reason: "new" }); expect(lead.sent).toEqual([]);
    lead.ctx.sessionManager = original;
    await lead.emit("session_start", { reason: "resume" }); await drain();
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.sessionId).toBe(leadIdentity.id);
    expect(lead.sent.join("\n")).toContain("explicit mail only");
  });

  it("explicit live handoff token accepts a new identity, but a random token cannot steal ownership", async () => {
    await runtime.setRuntimeActivity(team, "team-lead", "starting", { instanceId: "handoff-nonce" });
    const fresh = allocateSession(team, root);
    const moved = make(fresh, team, "team-lead", "handoff-nonce"); await moved.emit("session_start");
    expect((await teams.readConfig(team)).leadSessionId).toBe(fresh.id);
    const intruder = make(leadIdentity, team, "team-lead", "wrong-token"); await intruder.emit("session_start");
    expect(intruder.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("blocked");
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.sessionId).toBe(fresh.id);
  });

  it("backfills only a live owned legacy reload, never guesses dead legacy files", async () => {
    await teams.updateMember(team, "peer", { session: undefined });
    await runtime.setRuntimeActivity(team, "peer", "idle", { pid: process.pid, processStartToken: processToken, instanceId: "legacy",
      sessionId: peerIdentity.id, sessionFile: peerIdentity.file });
    const reloaded = make(peerIdentity, team, "peer"); await reloaded.emit("session_start", { reason: "reload" });
    expect((await teams.readConfig(team)).members.find(m => m.name === "peer")?.session?.id).toBe(peerIdentity.id);
    await reloaded.emit("session_shutdown");
    await teams.updateMember(team, "peer", { session: undefined });
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: 99999999 });
    const dead = make(peerIdentity, team, "peer"); await dead.emit("session_start", { reason: "startup" });
    expect(dead.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("legacy");
    expect((await teams.readConfig(team)).members).toHaveLength(2);
  });

  it("preserves unknown single-flight evidence without re-injection after process replacement", async () => {
    const message = await mail("peer");
    await runtime.setRuntimeActivity(team, "peer", "idle", { pid: 99999999, instanceId: "old",
      inboxAwaitingConfirmation: { messageIds: [message.id], since: 1, note: "unknown" } });
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await peer.emit("agent_start"); await peer.emit("agent_settled", { aborted: false }); await drain();
    expect(peer.sent).toEqual([]);
    expect((await messaging.readInbox(team, "peer", true, false))).toHaveLength(1);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.inboxAwaitingConfirmation?.messageIds).toEqual([message.id]);
  });

  it("explicit legacy association requires absent mapping and dead old authority, never force-takes a live lead", async () => {
    await teams.updateMember(team, "team-lead", { session: undefined });
    await runtime.setRuntimeActivity(team, "team-lead", "stopped", { instanceId: "legacy-dead", pid: 99999999 });
    const original = make(leadIdentity); await original.emit("session_start");
    await original.commands.get("team-resume").handler(team, original.ctx);
    expect((await teams.readConfig(team)).leadSessionId).toBe(leadIdentity.id);
    await teams.updateMember(team, "team-lead", { session: undefined });
    const other = make(allocateSession(team, root)); await other.emit("session_start");
    await expect(other.commands.get("team-resume").handler(team, other.ctx)).rejects.toThrow("still alive");
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.sessionId).toBe(leadIdentity.id);
  });

  it("formal team/delegate entrypoints persist actual lead and preallocated worker session identities", async () => {
    const freshIdentity = allocateSession(team, root);
    const owner = make(freshIdentity); await owner.emit("session_start");
    await owner.tools.get("team_create").execute("create", { team_name: "new-team" }, undefined, undefined, owner.ctx);
    await owner.tools.get("delegate_task").execute("delegate", { team_name: "new-team", teammate_name: "worker",
      cwd: root, task_subject: "preserved", task_description: "initial dispatch" }, undefined, undefined, owner.ctx);
    const config = await teams.readConfig("new-team");
    expect(config.leadSessionId).toBe(freshIdentity.id);
    const worker = config.members.find(m => m.name === "worker")!;
    expect(SessionManager.open(worker.session!.file).getSessionId()).toBe(worker.session!.id);
    expect(paneSpawns).toHaveLength(1);
    expect(paneSpawns[0].command).toContain(worker.session!.file);
    expect(paneSpawns[0].env.PI_SESSION_ID).toBeUndefined();
    expect(paneSpawns[0].env.PI_SESSION_FILE).toBeUndefined();
  });

  it("a partial initial spawn keeps task/mail/session reservation and rejects a blind duplicate retry", async () => {
    const target = { ...terminal(), name: "fake-other" };
    terminalState.adapter = target;
    const owner = make(leadIdentity); await owner.emit("session_start");
    const rename = fs.renameSync.bind(fs); let failed = false;
    target.spawn = (options: any) => {
      paneSpawns.push(options);
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!failed && String(to) === paths.configPath(team)) { failed = true; throw new Error("post-spawn config failure"); }
        return rename(from, to);
      });
      return "%partial";
    };
    const args = { team_name: team, teammate_name: "new-worker", cwd: root, task_subject: "keep", task_description: "preserve" };
    await expect(owner.tools.get("delegate_task").execute("first", args, undefined, undefined, owner.ctx)).rejects.toThrow("Launch unconfirmed");
    const retained = (await teams.readConfig(team)).members.find(m => m.name === "new-worker")!;
    expect(retained.session?.id).toBeTruthy(); expect(retained.recovery?.phase).toBe("launched");
    expect((await messaging.readInbox(team, "new-worker", true, false))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(paths.taskDir(team), "1.json"), "utf8"))).toMatchObject({ owner: "new-worker", status: "in_progress" });
    await expect(owner.tools.get("delegate_task").execute("retry", args, undefined, undefined, owner.ctx)).rejects.toThrow("unconfirmed");
    expect(paneSpawns).toHaveLength(1);
    expect((await teams.readConfig(team)).members.find(m => m.name === "new-worker")?.session?.id).toBe(retained.session?.id);
  });

  it("delegate reuse of a dead member restores its original conversation instead of replacing context/defaults", async () => {
    const target = { ...terminal(), name: "fake-other" }; terminalState.adapter = target;
    const owner = make(leadIdentity); await owner.emit("session_start"); target.name = "tmux";
    const result = await owner.tools.get("delegate_task").execute("follow-up", { team_name: team, teammate_name: "peer", cwd: root,
      task_subject: "follow-up", task_description: "new formal work", model: "obsolete/default", thinking: "max" }, undefined, undefined, owner.ctx);
    expect(result.details.restoreOutcome.status, result.details.restoreOutcome.note).toBe("restored");
    const member = (await teams.readConfig(team)).members.find(m => m.name === "peer")!;
    expect(member.session?.id).toBe(peerIdentity.id);
    expect(paneSpawns).toHaveLength(1);
    expect(paneSpawns[0].command).toContain(peerIdentity.file);
    expect(paneSpawns[0].command).not.toMatch(/--model|--thinking/);
    expect((await messaging.readInbox(team, "peer", true, false))).toHaveLength(1);
  });

  it("spawn_lead_window binds its preallocated new conversation and stale parent shutdown cannot stop it", async () => {
    const windows: any[] = [];
    terminalState.adapter = { ...terminal(), name: "fake-windows", supportsWindows: () => true,
      spawnWindow: (options: any) => { windows.push(options); return "window-1"; } };
    const original = make(leadIdentity); await original.emit("session_start");
    await original.tools.get("spawn_lead_window").execute("move", { team_name: team }, undefined, undefined, original.ctx);
    const newIdentity = (await teams.readConfig(team)).members.find(m => m.agentType === "lead")!.session!;
    expect(newIdentity.id).not.toBe(leadIdentity.id);
    expect(SessionManager.open(newIdentity.file).getSessionId()).toBe(newIdentity.id);
    expect(windows[0].command).toContain(newIdentity.file);
    const moved = make(newIdentity, team, "team-lead", windows[0].env.PI_TEAM_HANDOFF_TOKEN);
    await moved.emit("session_start");
    const lease = (await runtime.readRuntimeStatus(team, "team-lead"))!;
    await original.emit("session_shutdown");
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.instanceId).toBe(lease.instanceId);
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.detached).toBe(false);
  });

  it("session invalidation while handoff waits on the runtime lock cannot launch or shut down the new conversation", async () => {
    const windows: any[] = [];
    terminalState.adapter = { ...terminal(), name: "fake-windows", supportsWindows: () => true,
      spawnWindow: (options: any) => { windows.push(options); return "window-1"; } };
    const original = make(leadIdentity); await original.emit("session_start");
    const lock = `${paths.runtimeStatusPath(team, "team-lead")}.lock`; fs.writeFileSync(lock, "held fixture");
    const handoff = original.tools.get("spawn_lead_window").execute("move", { team_name: team }, undefined, undefined, original.ctx);
    // Attach a rejection observer immediately; the assertion awaits it below.
    const outcome = handoff.then(() => "unexpected success", (error: Error) => error.message);
    await drain();
    original.ctx.sessionManager = SessionManager.create(root, path.join(root, "unrelated-new"));
    const switched = original.emit("session_start", { reason: "new" });
    await drain(); fs.unlinkSync(lock); await switched;
    expect(await outcome).toContain("no longer owns");
    expect(windows).toEqual([]); expect(original.ctx.shutdown).not.toHaveBeenCalled();
    expect((await teams.readConfig(team)).members.find(m => m.name === "team-lead")?.session?.id).toBe(leadIdentity.id);
  });

  it("a shutdown delayed on a real runtime lock cannot stop a replacement owner", async () => {
    const peer = make(peerIdentity); await peer.emit("session_start");
    const file = paths.runtimeStatusPath(team, "peer");
    fs.writeFileSync(`${file}.lock`, "held fixture");
    const shutdown = peer.emit("session_shutdown", { reason: "resume" });
    await drain();
    const status = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...status, instanceId: "replacement", activity: "idle", detached: false }));
    fs.unlinkSync(`${file}.lock`); await shutdown;
    expect((await runtime.readRuntimeStatus(team, "peer"))).toMatchObject({ instanceId: "replacement", activity: "idle", detached: false });
  });

  it("uses real SDK successful prompt/settled lifecycle and same-session reload without an LLM", async () => {
    terminalState.adapter = null;
    const manager = SessionManager.open(peerIdentity.file);
    const { session, events } = await sdk(manager);
    await session.setModel(getModel("openai", "o3-mini"));
    session.setThinkingLevel("high");
    await session.prompt("direct test prompt", { expandPromptTemplates: false });
    expect(session.getLastAssistantText()).toBe("fake provider success");
    expect(events.find(e => e.type === "agent_settled")).toMatchObject({ aborted: false });
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).toBe("idle");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); session.dispose();
    const reopened = await sdk(SessionManager.open(peerIdentity.file), "reload");
    expect(reopened.session.sessionId).toBe(peerIdentity.id);
    expect(reopened.session.model?.id).toBe("o3-mini");
    expect(reopened.session.thinkingLevel).toBe("high");
    expect(reopened.session.messages.some((m: any) => m.role === "user"
      && (m.content === "direct test prompt" || m.content?.some?.((part: any) => part.text === "direct test prompt")))).toBe(true);
    expect((await runtime.readRuntimeStatus(team, "peer"))?.activity).toBe("idle");
  });

  it("registered team_shutdown removes metadata but preserves confirmed Pi history/model for manual resume", async () => {
    terminalState.adapter = { ...terminal(), name: "fake-other" };
    const { session } = await sdk(SessionManager.open(peerIdentity.file));
    await session.setModel(getModel("openai", "o3-mini")); session.setThinkingLevel("high");
    await session.prompt("keep this conversation after dissolution", { expandPromptTemplates: false });
    expect((await teams.readConfig(team)).members.find(m => m.name === "peer")?.session?.confirmed).toBe(true);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    actualSessions.splice(actualSessions.indexOf(session), 1);
    // Simulate the exited peer; never send a real signal to this test process.
    await runtime.setRuntimeActivity(team, "peer", "stopped", { pid: 99999999, processStartToken: undefined });
    const owner = make(leadIdentity); await owner.emit("session_start");
    fs.writeFileSync(path.join(paths.taskDir(team), "1.json"), '{"id":"1","status":"in_progress","owner":"peer"}');
    await mail("peer");
    const before = fs.readFileSync(peerIdentity.file);
    await owner.tools.get("team_shutdown").execute("dissolve", { team_name: team }, undefined, undefined, owner.ctx);
    expect(fs.existsSync(paths.teamDir(team))).toBe(false);
    expect(fs.existsSync(paths.taskDir(team))).toBe(false);
    expect(fs.existsSync(paths.inboxPath(team, "peer"))).toBe(false);
    expect(fs.readFileSync(peerIdentity.file).equals(before)).toBe(true);
    const resumed = SessionManager.open(peerIdentity.file);
    expect(resumed.getSessionId()).toBe(peerIdentity.id);
    expect(resumed.buildSessionContext()).toMatchObject({ model: { provider: "openai", modelId: "o3-mini" }, thinkingLevel: "high" });
    expect(resumed.buildSessionContext().messages.some((message: any) => message.role === "user"
      && message.content?.some?.((part: any) => part.text === "keep this conversation after dissolution"))).toBe(true);
    expect(findSessionMember(peerIdentity)).toBeUndefined();
    const manual = make(peerIdentity); await manual.emit("session_start"); await drain();
    expect(manual.sent).toEqual([]);
    await expect(manual.tools.get("team_wait").execute("wait", { team_name: team }, undefined, undefined, manual.ctx))
      .rejects.toThrow("bound to team none");
  });

  it("actual AgentSessionRuntime new/fork/resume replaces identity without inheriting the team", async () => {
    terminalState.adapter = null;
    const reasons: string[] = [];
    const host = await createAgentSessionRuntime(async options => {
      const reason = options.sessionStartEvent?.reason ?? "startup";
      reasons.push(reason);
      const result = await sdk(options.sessionManager, reason);
      // Runtime only needs agentDir for replacement; all actual session/model/
      // loader services are supplied by sdk(). No host methods are overridden.
      return { ...result, services: { cwd: root, agentDir: path.join(root, "agent") }, diagnostics: [] } as any;
    }, { cwd: root, agentDir: path.join(root, "agent"), sessionManager: SessionManager.open(leadIdentity.file) });
    try {
      await host.session.prompt("runtime original", { expandPromptTemplates: false });
      expect(host.session.getLastAssistantText()).toBe("fake provider success");
      const user: any = host.session.sessionManager.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "user");
      await host.fork(user.id, { position: "at" });
      expect(host.session.sessionId).not.toBe(leadIdentity.id);
      expect((await runtime.readRuntimeStatus(team, "team-lead"))?.detached).toBe(true);
      await host.switchSession(leadIdentity.file);
      expect(host.session.sessionId).toBe(leadIdentity.id);
      expect((await runtime.readRuntimeStatus(team, "team-lead"))?.detached).toBe(false);
      await host.newSession();
      expect(host.session.sessionId).not.toBe(leadIdentity.id);
      expect((await runtime.readRuntimeStatus(team, "team-lead"))?.detached).toBe(true);
      await host.switchSession(leadIdentity.file);
      expect((await runtime.readRuntimeStatus(team, "team-lead"))?.sessionId).toBe(leadIdentity.id);
      expect(reasons).toEqual(["startup", "fork", "resume", "new", "resume"]);
    } finally { await host.dispose(); }
  });
});
