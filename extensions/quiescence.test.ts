// Project: pi-teams
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";
import { fixtureSession } from "./session-test-fixture";
import type { Member } from "../src/utils/models";
import * as messaging from "../src/utils/messaging";
import * as paths from "../src/utils/paths";
import * as predefined from "../src/utils/predefined-teams";
import * as runtimeModule from "../src/utils/runtime";
import { readRuntimeStatus, setRuntimeActivity, getProcessStartToken, type AgentActivity } from "../src/utils/runtime";
import { openFormalGeneration, QUIESCENCE_MARKER, readQuiescenceState } from "../src/utils/quiescence";

const terminalState = vi.hoisted(() => ({ adapter: null as any }));
vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => terminalState.adapter,
}));

const teamName = "quiescence-feature";
const teammateName = "implementer";
const workerName = "worker";
const homePi = path.join(os.homedir(), ".pi");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type RegisteredTool = {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
};

interface LoadedExtension {
  agentName: string;
  handlers: Map<string, Handler[]>;
  tools: Map<string, RegisteredTool>;
  sent: string[];
  ctx: { isIdle: () => boolean; cwd: string; ui: { notify: () => void; setStatus: () => void; setTitle: () => void } };
}

let injectionHook: ((text: string) => void) | undefined;
const loaded: LoadedExtension[] = [];
const pendingHostPromises: Array<Promise<unknown>> = [];
let root = "";

function assertIsolated(target: string) {
  const resolved = path.resolve(target);
  if (resolved === homePi || resolved.startsWith(homePi + path.sep)) {
    throw new Error(`quiescence test tried to touch ${resolved}`);
  }
}

function member(name: string): Member {
  return {
    agentId: `${name}@${teamName}`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    joinedAt: 1,
    tmuxPaneId: "",
    cwd: root,
    subscriptions: [],
  };
}

function writeTeamConfig() {
  const dir = path.join(root, "teams", teamName);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, "tasks", teamName), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    name: teamName,
    description: "Isolated quiescence feature fixture",
    createdAt: 1,
    leadAgentId: "team-lead@quiescence-feature",
    leadSessionId: "quiescence-feature",
    members: [member("team-lead"), member(teammateName), member(workerName)],
  }));
}

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function loadExtension(agentName: string): LoadedExtension {
  if (!process.env.PI_TEAM_NAME && agentName !== "team-lead") {
    throw new Error("Refusing to load a teammate without an isolated PI_TEAM_NAME");
  }
  vi.stubEnv("PI_AGENT_NAME", agentName);
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, RegisteredTool>();
  const sent: string[] = [];
  const ctx = {
    sessionManager: fixtureSession(root, teamName, agentName),
    isIdle: () => true,
    cwd: root,
    ui: { notify() {}, setStatus() {}, setTitle() {} },
  };
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => undefined;
    },
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
      injectionHook?.(text);
    },
  };
  extension(api as unknown as ExtensionAPI);
  const loadedExtension = { agentName, handlers, tools, sent, ctx };
  loaded.push(loadedExtension);
  return loadedExtension;
}

async function emit(target: LoadedExtension, name: string, event: unknown = { type: name }) {
  const handlers = target.handlers.get(name) ?? [];
  expect(handlers, name).not.toHaveLength(0);
  await handlers[0](event, target.ctx);
}

async function startSession(target: LoadedExtension) {
  await emit(target, "session_start", { type: "session_start" });
  await drain();
}

async function activityOf(agentName: string): Promise<AgentActivity | undefined> {
  return (await readRuntimeStatus(teamName, agentName))?.activity;
}

async function unread(agentName: string) {
  return messaging.readInbox(teamName, agentName, true, false);
}

async function leaveUnread(agentName: string, text: string) {
  return messaging.appendMessage(teamName, agentName, {
    from: "team-lead",
    text,
    timestamp: new Date(0).toISOString(),
    read: false,
    summary: text,
  });
}

async function workerIdle(agentName: string, instanceId = `instance-${agentName}`) {
  await setRuntimeActivity(teamName, agentName, "idle", {
    instanceId,
    pid: process.pid,
    processStartToken: getProcessStartToken(process.pid),
    startedAt: 1,
    activityChangedAt: 1,
    lastHeartbeatAt: 1,
  });
}

/** Preserve the live lead's instance lease; only the activity changes. */
async function leadIdle() {
  await setRuntimeActivity(teamName, "team-lead", "idle");
}

async function allIdle() {
  await leadIdle();
  await workerIdle(teammateName);
  await workerIdle(workerName);
}

async function pollTicks(times: number) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await drain();
  }
}

async function delegate(lead: LoadedExtension, prompt = "do the work") {
  return lead.tools.get("delegate_task")!.execute("delegate", {
    team_name: teamName,
    teammate_name: workerName,
    cwd: root,
    task_subject: "quiescence work",
    task_description: prompt,
  }, undefined, undefined, { cwd: root });
}

async function consumeWorkerMailAndIdle() {
  await messaging.readInbox(teamName, workerName, true, true);
  await workerIdle(workerName);
}

function confirm(target: LoadedExtension, text: string) {
  return emit(target, "message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  });
}

async function loadInstalledHost() {
  const sessionMod = await import(pathToFileURL(path.resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
  )).href) as { AgentSession: { prototype: any } };
  const loopMod = await import(pathToFileURL(path.resolve(
    "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
  )).href) as { runAgentLoop: (...args: any[]) => Promise<unknown> };
  return { AgentSession: sessionMod.AgentSession, runAgentLoop: loopMod.runAgentLoop };
}

function promptHost(target: LoadedExtension, AgentSession: { prototype: any }, runAgentLoop: (...args: any[]) => Promise<unknown>) {
  const host: any = Object.create(AgentSession.prototype);
  host.agent = { state: { model: { id: "quiescence-fake", provider: "audit", api: "openai-completions" } } };
  host._isAgentRunActive = false;
  host._runInputHandlers = async (text: string, images: unknown) => ({ text, images });
  host._flushPendingBashMessages = () => {};
  host._flushPendingCustomMessages = () => {};
  host._modelRuntime = { hasConfiguredAuth: () => true };
  host._findLastAssistantMessage = () => undefined;
  host._baseSystemPromptOptions = { selectedTools: [] };
  host.getActiveToolNames = () => [];
  host._extensionRunner = { emitBeforeAgentStart: async () => ({ systemPromptOptions: { selectedTools: [] }, messages: [] }) };
  host._normalizePromptImages = async () => ({ images: [], hints: [] });
  host._pendingNextTurnMessages = [];
  host._preparePromptAndToolLoadout = () => undefined;
  host._runAgentPrompt = async (messages: any[]) => {
    host._isAgentRunActive = true;
    try {
      await runAgentLoop(messages, { systemPrompt: "", messages: [] }, {
        model: host.agent.state.model,
        convertToLlm: async (msgs: unknown[]) => msgs,
        getApiKey: async () => "not-a-real-key",
      }, async (event: any) => {
        if (event.type === "agent_start") await emit(target, "agent_start", event);
        if (event.type === "message_end" && event.message.role === "user") await emit(target, "message_end", event);
      }, undefined, async () => {
        throw new Error("quiescence fake provider: no network");
      });
    } finally {
      host._isAgentRunActive = false;
      await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    }
  };
  target.ctx.isIdle = () => !host._isAgentRunActive;
  injectionHook = (text) => {
    pendingHostPromises.push(host.sendUserMessage(text).catch((error: Error) => {
      if (!/quiescence fake provider/.test(error.message)) throw error;
    }));
  };
  return host;
}

async function useInstalledRunner(target: LoadedExtension) {
  const mod = await import(pathToFileURL(path.resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
  )).href);
  const runner: any = Object.create(mod.ExtensionRunner.prototype);
  runner.extensions = [{ path: "isolated-pi-teams", handlers: new Map(target.handlers) }];
  runner.createContext = () => target.ctx;
  runner.emitError = () => undefined;
  for (const name of ["agent_start", "agent_settled", "message_end"]) {
    target.handlers.set(name, [(event: any) => name === "message_end" ? runner.emitMessageEnd(event) : runner.emit(event)]);
  }
}

beforeEach(() => {
  injectionHook = undefined;
  terminalState.adapter = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-quiescence-feature-"));
  assertIsolated(root);
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(team => {
    const target = path.join(root, "teams", team);
    assertIsolated(target);
    return target;
  });
  vi.spyOn(paths, "taskDir").mockImplementation(team => {
    const target = path.join(root, "tasks", team);
    assertIsolated(target);
    return target;
  });
  vi.spyOn(paths, "inboxPath").mockImplementation((team, agent) => {
    const target = path.join(root, "teams", team, "inboxes", `${agent}.json`);
    assertIsolated(target);
    return target;
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((team, agent) => {
    const target = path.join(root, "teams", team, "runtime", `${agent}.json`);
    assertIsolated(target);
    return target;
  });
  vi.spyOn(paths, "configPath").mockImplementation(team => {
    const target = path.join(root, "teams", team, "config.json");
    assertIsolated(target);
    return target;
  });
  vi.spyOn(paths, "leadSessionPath").mockImplementation(team => {
    const target = path.join(root, "teams", team, "lead-session.json");
    assertIsolated(target);
    return target;
  });
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", teammateName);
  writeTeamConfig();
  vi.useFakeTimers();
});

afterEach(async () => {
  await Promise.allSettled(pendingHostPromises.splice(0));
  for (const target of loaded.splice(0)) {
    const shutdown = target.handlers.get("session_shutdown")?.[0];
    if (shutdown) await Promise.resolve(shutdown({ type: "session_shutdown" }, target.ctx)).catch(() => undefined);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe("registered team quiescence fallback", () => {
  it("does not wake the lead with no formal dispatch", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await pollTicks(5);

    expect(await unread("team-lead")).toEqual([]);
    expect(lead.sent).toEqual([]);
    expect((await readQuiescenceState(teamName)).generation).toBe(0);
  });

  it("opens a generation on delegate_task and admits exactly one inspection", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();

    const delegated = await delegate(lead);
    expect(delegated.content[0].text).toContain(`delegated to ${workerName}`);
    expect((await readQuiescenceState(teamName)).generation).toBe(1);

    // The queued delegated mail is real work, so no fallback yet.
    await pollTicks(2);
    expect(await unread("team-lead")).toEqual([]);

    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    const first = await unread("team-lead");
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain(QUIESCENCE_MARKER);
    expect(first[0].text).toContain("Generation: 1");
    expect(first[0].text).toContain("does not mark any task complete");

    await pollTicks(3);
    expect(await unread("team-lead")).toHaveLength(1);
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);
  });

  it("does not check a generation on the dispatch settlement and checks only the accepted tagged settlement", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);

    // Dispatch run settles without any inspection acceptance.
    await emit(lead, "agent_start");
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);
    expect(lead.sent).toHaveLength(1);
    expect(lead.sent[0]).toContain(QUIESCENCE_MARKER);

    await emit(lead, "agent_start");
    await confirm(lead, lead.sent[0]);
    expect((await readQuiescenceState(teamName)).inspection?.phase).toBe("accepted");
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(1);
    expect(state.inspection).toBeUndefined();
    expect(await unread("team-lead")).toEqual([]);
  });

  it("releases an aborted accepted inspection without checking or auto-resuming", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);
    const delivered = lead.sent[0];
    expect(delivered).toContain(QUIESCENCE_MARKER);

    await emit(lead, "agent_start");
    await confirm(lead, delivered);
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: true });

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(state.inspection).toBeUndefined();
    expect(await activityOf("team-lead")).toBe("interrupted");

    const sentBefore = lead.sent.length;
    await pollTicks(5);
    expect(lead.sent.length).toBe(sentBefore);
  });

  it("does not re-arm after checked work while direct human turns and explicit messages continue", async () => {
    const lead = loadExtension("team-lead");
    const worker = loadExtension(workerName);
    await startSession(lead);
    await startSession(worker);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);

    await emit(lead, "agent_start");
    await confirm(lead, lead.sent[0]);
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(1);

    // Human turns in the worker session must not open or re-check anything.
    await emit(worker, "agent_start");
    await emit(worker, "agent_settled", { type: "agent_settled", aborted: false });
    await emit(lead, "agent_start");
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(3);
    const state = await readQuiescenceState(teamName);
    expect(state.generation).toBe(1);
    expect(state.checkedGeneration).toBe(1);
    expect(await unread("team-lead")).toEqual([]);

    // An explicit report is still delivered immediately.
    await worker.tools.get("team_message")!.execute("report", {
      team_name: teamName,
      to: "team-lead",
      content: "explicit status report",
      summary: "report",
    }, undefined, undefined, { cwd: root });
    const reports = await unread("team-lead");
    expect(reports.map(message => message.text)).toContain("explicit status report");
    expect((await readQuiescenceState(teamName)).generation).toBe(1);
  });

  it("does not swallow a later generation and admits a new inspection after the old one is consumed", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);

    // Accept generation 1, then open generation 2 before that run settles.
    await emit(lead, "agent_start");
    await confirm(lead, lead.sent[0]);
    await delegate(lead);
    expect((await readQuiescenceState(teamName)).generation).toBe(2);
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });

    const afterFirst = await readQuiescenceState(teamName);
    expect(afterFirst.checkedGeneration).toBe(1);
    expect(afterFirst.inspection).toBeUndefined();

    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    const messages = await unread("team-lead");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("Generation: 2");

    await pollTicks(1);
    await emit(lead, "agent_start");
    await confirm(lead, lead.sent.at(-1)!);
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(2);
  });

  it("keeps explicit task_complete notifications deliverable with no generation change", async () => {
    const worker = loadExtension(workerName);
    await startSession(worker);
    await allIdle();
    const taskPath = path.join(root, "tasks", teamName, "1.json");
    fs.writeFileSync(taskPath, JSON.stringify({
      id: "1",
      subject: "explicit completion",
      description: "report immediately",
      status: "in_progress",
      owner: workerName,
      blocks: [],
      blockedBy: [],
    }));

    await worker.tools.get("task_complete")!.execute("complete", {
      team_name: teamName,
      task_id: "1",
      summary: "done",
    }, undefined, undefined, { cwd: root });

    const reports = await unread("team-lead");
    expect(reports.map(message => message.text).join("\n")).toContain("was marked completed");
    expect((await readQuiescenceState(teamName)).generation).toBe(0);
  });

  it("treats an ordinary continuation message differently from a formal follow-up", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);
    await emit(lead, "agent_start");
    await confirm(lead, lead.sent[0]);
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(1);

    await lead.tools.get("team_message")!.execute("continue", {
      team_name: teamName,
      to: workerName,
      content: "please continue with more polish",
    }, undefined, undefined, { cwd: root });
    expect((await readQuiescenceState(teamName)).generation).toBe(1);

    await consumeWorkerMailAndIdle();
    await delegate(lead, "follow-up work");
    expect((await readQuiescenceState(teamName)).generation).toBe(2);
  });

  it("checks the generation through the real host message_end acceptance path", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();

    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    await useInstalledRunner(lead);
    promptHost(lead, AgentSession, runAgentLoop);

    await pollTicks(1);
    await pollTicks(1);
    await Promise.all(pendingHostPromises);
    await drain();

    expect(lead.sent).toHaveLength(1);
    expect(lead.sent[0]).toContain(QUIESCENCE_MARKER);
    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(1);
    expect(state.inspection).toBeUndefined();
  });

  it("arms a generation from a predefined template launch", async () => {
    const fakeTerminal = {
      name: "tmux",
      spawn: vi.fn(() => "%7"),
      supportsWindows: () => false,
      isAlive: () => true,
      kill: () => {},
      killWindow: () => {},
      isWindowAlive: () => false,
      setTitle: () => {},
      setSpawnContext: () => {},
    };
    terminalState.adapter = fakeTerminal;
    vi.spyOn(predefined, "getPredefinedTeam").mockReturnValue({ name: "template", agents: ["template-worker"] });
    vi.spyOn(predefined, "getAllAgentDefinitions").mockReturnValue([{
      name: "template-worker",
      description: "test worker",
      prompt: "do template work",
      filePath: "",
    }]);
    vi.stubEnv("PI_TEAM_NAME", "");
    // A predefined template launches into a new team name; the fixture config
    // stands in for dispatch only and must not already exist.
    fs.rmSync(path.join(root, "teams", teamName, "config.json"));

    const lead = loadExtension("team-lead");
    await startSession(lead);
    const result = await lead.tools.get("create_predefined_team")!.execute("template", {
      team_name: teamName,
      predefined_team: "template",
      cwd: root,
    }, undefined, undefined, { cwd: root });

    expect(result.details.results).toEqual([{ name: "template-worker", status: "spawned", error: undefined }]);
    expect(fakeTerminal.spawn).toHaveBeenCalledTimes(1);
    expect((await readQuiescenceState(teamName)).generation).toBe(1);
  });

  it("does not expose teammate control-mode API or residue", () => {
    const lead = loadExtension("team-lead");
    // Model switching is not the removed user/team control-mode feature.
    expect([...lead.tools.keys()].filter(name => /(?:^|_)mode(?:_|$)|takeover|flush|handback/i.test(name))).toEqual([]);
    const source = fs.readFileSync(path.resolve("extensions/index.ts"), "utf-8");
    expect(source).not.toMatch(/\bcontrolMode\b|\bteam-mode\b|\bcontrol-state\b|\btakeover\b/i);
  });
});

describe("inspection release recovery", () => {
  async function acceptedInspectionReady() {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await allIdle();
    await delegate(lead);
    await consumeWorkerMailAndIdle();
    await pollTicks(1);
    await pollTicks(1);
    expect(lead.sent).toHaveLength(1);
    await emit(lead, "agent_start");
    await confirm(lead, lead.sent[0]);
    expect((await readQuiescenceState(teamName)).inspection?.phase).toBe("accepted");
    return lead;
  }

  function failQuiescenceRenames() {
    const control = { fail: true, failures: 0 };
    const real = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(path.join("teams", teamName, "quiescence.json")) && control.fail) {
        control.failures += 1;
        throw new Error("test: transient release rename failure");
      }
      return real(from, to);
    });
    return { control, spy };
  }

  function quiescenceFile() {
    return path.join(root, "teams", teamName, "quiescence.json");
  }

  // Pauses the first runtime read made while the coordinator lock is held, using
  // a real runtime lock file. The read itself still delegates to the real
  // implementation; no guard result is fabricated.
  function pauseGuardRead() {
    const real = runtimeModule.readRuntimeStatus;
    const runtimeFile = path.join(root, "teams", teamName, "runtime", "team-lead.json");
    let entered = false;
    const spy = vi.spyOn(runtimeModule, "readRuntimeStatus").mockImplementation(async (team, agent) => {
      if (!entered && agent === "team-lead" && fs.existsSync(quiescenceFile() + ".lock")) {
        entered = true;
        fs.writeFileSync(runtimeFile + ".lock", String(process.pid), { flag: "wx" });
      }
      return real(team, agent);
    });
    return {
      entered: () => entered,
      runtimeFile,
      release: () => fs.unlinkSync(runtimeFile + ".lock"),
      spy,
    };
  }

  it("recovers after exactly one failed release rename and needs a fresh inspection after resume", async () => {
    const lead = await acceptedInspectionReady();
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
    fault.spy.mockRestore();
    expect(fault.control.failures).toBe(1);
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    // While paused, the retry is metadata-only: no check, no wake, no resume.
    await pollTicks(3);
    expect(lead.sent).toHaveLength(1);
    expect(await activityOf("team-lead")).toBe("interrupted");
    expect((await readQuiescenceState(teamName)).inspection).toBeUndefined();

    // A direct resume settles normally but must not acknowledge the aborted
    // inspection; a fresh inspection becomes eligible for the same generation.
    await emit(lead, "agent_start");
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(5);
    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(state.inspection?.phase).not.toBe("accepted");
    expect(lead.sent.length).toBeGreaterThan(1);
    expect(lead.sent.at(-1)).toContain(QUIESCENCE_MARKER);
  });

  it("retains the release obligation through repeated transient failures without checking or waking", async () => {
    const lead = await acceptedInspectionReady();
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
    await pollTicks(6);
    expect(fault.control.failures).toBeGreaterThanOrEqual(2);
    expect(lead.sent).toHaveLength(1);
    expect(await activityOf("team-lead")).toBe("interrupted");
    expect((await readQuiescenceState(teamName)).inspection?.phase).toBe("accepted");
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    fault.control.fail = false;
    await pollTicks(8);
    const released = await readQuiescenceState(teamName);
    expect(released.inspection).toBeUndefined();
    expect(released.checkedGeneration).toBe(0);
    expect(lead.sent).toHaveLength(1);

    await emit(lead, "agent_start");
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(3);
    const fresh = await readQuiescenceState(teamName);
    expect(fresh.checkedGeneration).toBe(0);
    expect(fresh.inspection?.phase).toBe("pending");
    expect(lead.sent).toHaveLength(2);
    fault.spy.mockRestore();
  });

  it("tags the fresh inspection with a generation opened while release was outstanding", async () => {
    const lead = await acceptedInspectionReady();
    const staleId = (await readQuiescenceState(teamName)).inspection!.messageId;
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
    expect(fault.control.failures).toBe(1);
    // Storage is healthy for the follow-up dispatch; only the already-scheduled
    // release retry is still outstanding at this point.
    fault.control.fail = false;

    await delegate(lead, "follow-up work");
    await consumeWorkerMailAndIdle();
    const mid = await readQuiescenceState(teamName);
    expect(mid.generation).toBe(2);
    expect(mid.inspection?.messageId).toBe(staleId);
    expect(mid.inspection?.phase).toBe("accepted");
    expect(lead.sent).toHaveLength(1);

    // The retry releases only the old message id; the newer generation is not
    // swallowed and still needs its own fresh inspection after a legitimate resume.
    await pollTicks(3);
    expect((await readQuiescenceState(teamName)).inspection).toBeUndefined();
    expect(lead.sent).toHaveLength(1);

    await emit(lead, "agent_start");
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(3);
    const fresh = await readQuiescenceState(teamName);
    expect(fresh.checkedGeneration).toBe(0);
    expect(fresh.inspection?.generation).toBe(2);
    expect(fresh.inspection?.phase).toBe("pending");
    expect(fresh.inspection?.messageId).not.toBe(staleId);
    expect(lead.sent.at(-1)).toContain("Generation: 2");
    fault.spy.mockRestore();
  });

  it("does not check when the leader lease is replaced while the ACK waits on the coordinator lock", async () => {
    const lead = await acceptedInspectionReady();
    const qfile = path.join(root, "teams", teamName, "quiescence.json");
    fs.writeFileSync(qfile + ".lock", String(process.pid), { flag: "wx" });
    const settle = emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    try {
      await drain();
      // The settlement published idle and its ACK is now waiting on the lock.
      expect(await activityOf("team-lead")).toBe("idle");
      await setRuntimeActivity(teamName, "team-lead", "running", { instanceId: "replacement-lead" });
    } finally {
      fs.unlinkSync(qfile + ".lock");
    }
    await vi.advanceTimersByTimeAsync(100);
    await settle;

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    // A replacement lead's later admission may drop the stale accepted record,
    // but this generation must never be recorded as checked by the old lease.
    expect(state.checkedGeneration).toBeLessThan(state.generation);
  });

  it("does not check when an abort revokes the ACK while it waits on the coordinator lock", async () => {
    const lead = await acceptedInspectionReady();
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    expect(fault.control.failures).toBe(1);
    fault.control.fail = false;
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    const qfile = path.join(root, "teams", teamName, "quiescence.json");
    fs.writeFileSync(qfile + ".lock", String(process.pid), { flag: "wx" });
    try {
      // The poll retry passes its runtime check and waits on the coordinator lock.
      await pollTicks(1);
      await emit(lead, "agent_start");
      const abort = emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
      await drain();
      expect(await activityOf("team-lead")).toBe("interrupted");
      fs.unlinkSync(qfile + ".lock");
      await vi.advanceTimersByTimeAsync(100);
      await abort;
    } finally {
      if (fs.existsSync(qfile + ".lock")) fs.unlinkSync(qfile + ".lock");
    }

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(lead.sent).toHaveLength(1);
    expect(await activityOf("team-lead")).toBe("interrupted");
    fault.spy.mockRestore();
  });

  it("arms the advertised 100ms release backoff after a transient failure", async () => {
    const lead = await acceptedInspectionReady();
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
    expect(fault.control.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    const attempts = fault.control.failures;
    fault.spy.mockRestore();
    expect(attempts).toBe(2);
    expect(await activityOf("team-lead")).toBe("interrupted");
    expect(lead.sent).toHaveLength(1);
  });

  it("keeps the release duty when an abort revokes an ACK parked on the guard runtime read", async () => {
    const lead = await acceptedInspectionReady();
    const fault = failQuiescenceRenames();
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    fault.spy.mockRestore();
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    // Legitimate earlier ACK metadata retry may overlap a subsequent direct run.
    await emit(lead, "agent_start");
    const pause = pauseGuardRead();
    await pollTicks(1);
    expect(pause.entered()).toBe(true);
    const abort = emit(lead, "agent_settled", { type: "agent_settled", aborted: true });
    await drain();
    pause.release();
    await vi.advanceTimersByTimeAsync(100);
    await abort;
    pause.spy.mockRestore();
    await pollTicks(3);

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(lead.sent).toHaveLength(1);
    expect(await activityOf("team-lead")).toBe("interrupted");
    expect(state.inspection).toBeUndefined();
  });

  it("retains the ACK obligation when the guard runtime read fails transiently", async () => {
    const lead = await acceptedInspectionReady();
    const real = runtimeModule.readRuntimeStatus;
    let thrown = false;
    const spy = vi.spyOn(runtimeModule, "readRuntimeStatus").mockImplementation(async (team, agent) => {
      if (!thrown && agent === "team-lead" && fs.existsSync(quiescenceFile() + ".lock")) {
        thrown = true;
        throw new Error("test: transient guard runtime read");
      }
      return real(team, agent);
    });
    await emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    spy.mockRestore();
    expect(thrown).toBe(true);
    const mid = await readQuiescenceState(teamName);
    expect(mid.checkedGeneration).toBe(0);
    expect(mid.inspection?.phase).toBe("accepted");

    await pollTicks(1);
    const after = await readQuiescenceState(teamName);
    expect(after.checkedGeneration).toBe(1);
    expect(after.inspection).toBeUndefined();
  });

  it("lets a replacement admit a fresh inspection after the old ACK is rejected", async () => {
    const lead = await acceptedInspectionReady();
    const staleId = (await readQuiescenceState(teamName)).inspection!.messageId;
    const qfile = quiescenceFile();
    fs.writeFileSync(qfile + ".lock", String(process.pid), { flag: "wx" });
    const settle = emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    try {
      await drain();
      await setRuntimeActivity(teamName, "team-lead", "running", { instanceId: "replacement-lead" });
    } finally {
      fs.unlinkSync(qfile + ".lock");
    }
    await vi.advanceTimersByTimeAsync(100);
    await settle;
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);

    // The replacement is quiescent and must not stay blocked by the rejected
    // old record: admission can create a fresh inspection for the same E.
    await setRuntimeActivity(teamName, "team-lead", "idle", { instanceId: "replacement-lead" });
    await pollTicks(1);
    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(state.inspection?.phase).toBe("pending");
    expect(state.inspection?.messageId).not.toBe(staleId);
  });

  it("checks only E for a delayed non-revoked ACK while a newer E+1 stays unchecked", async () => {
    const lead = await acceptedInspectionReady();
    await openFormalGeneration(teamName);
    const pause = pauseGuardRead();
    const settle = emit(lead, "agent_settled", { type: "agent_settled", aborted: false });
    await drain();
    expect(pause.entered()).toBe(true);
    pause.release();
    await vi.advanceTimersByTimeAsync(100);
    await settle;
    pause.spy.mockRestore();

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(1);
    expect(state.generation).toBe(2);
  });
});
