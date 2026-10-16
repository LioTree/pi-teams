import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import { controlStatePath, readControlStateSync } from "../src/utils/control-state";

vi.mock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => null }));
const repoRoot = process.cwd();
const team = "control-extension";
const worker = "implementer";
let root = "";
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Command = { name: string; description: string; handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null };
interface Loaded {
  name: string;
  handlers: Map<string, Handler[]>;
  commands: Map<string, Command>;
  tools: Map<string, any>;
  sent: string[];
  ctx: { isIdle: () => boolean; ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } };
  inject?: (text: string) => void;
}
const loaded: Loaded[] = [];
const waits: AbortController[] = [];
const state = () => readControlStateSync(team, worker);
const mail = (name = "team-lead", unreadOnly = false) => messaging.readInbox(team, name, unreadOnly, false);
async function drain() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
async function ticks(n = 1) { for (let i = 0; i < n; i++) { await vi.advanceTimersByTimeAsync(1000); await drain(); } }
async function emit(target: Loaded, event: string, value: any = { type: event }) {
  const handler = target.handlers.get(event)?.[0];
  expect(handler, event).toBeDefined();
  await handler!(value, target.ctx);
}
const command = (target: Loaded, args = "") => target.commands.get("team-mode")!.handler(args, target.ctx);
const execute = (target: Loaded, name: string, args: any, signal?: AbortSignal) => target.tools.get(name)!.execute("control-test", args, signal, undefined, target.ctx);
async function turn(target: Loaded, aborted = false) {
  await emit(target, "agent_start");
  await emit(target, "agent_settled", { type: "agent_settled", aborted });
}
function load(name: string, bound = true) {
  vi.stubEnv("PI_AGENT_NAME", name);
  vi.stubEnv("PI_TEAM_NAME", bound ? team : undefined);
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  const target: Loaded = {
    name, handlers: new Map(), commands: new Map(), tools: new Map(), sent: [],
    ctx: { isIdle: () => true, ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } },
  };
  extension({
    on: (event: string, handler: Handler) => { target.handlers.set(event, [...(target.handlers.get(event) ?? []), handler]); },
    registerTool: (tool: any) => { target.tools.set(tool.name, tool); },
    registerCommand: (name: string, value: Omit<Command, "name">) => { target.commands.set(name, { name, ...value }); },
    sendUserMessage: (text: string) => { target.sent.push(text); target.inject?.(text); },
  } as unknown as ExtensionAPI);
  loaded.push(target);
  return target;
}
async function start(name = worker, user = true) {
  const target = load(name);
  await emit(target, "session_start"); await drain();
  if (user) await command(target, "user");
  return target;
}
function hold(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".lock", "held by actual filesystem regression", { flag: "wx" });
  return () => fs.unlinkSync(file + ".lock");
}
async function makeTask() {
  const task = await tasks.createTask(team, "Do real work", "Multiple human work turns are not task completion");
  return tasks.assignTask(team, task.id, worker, { assignedBy: "team-lead", status: "in_progress", notifyOwner: false });
}

// Real installed command dispatch + ExtensionRunner error containment + core
// loop acceptance and normal assistant completion. The provider returns only a
// local fixed event stream: no credentials, CLI, network, or real model call.
async function installedHost(target: Loaded, providerGate: () => Promise<void> = async () => {}) {
  const { AgentSession } = await import(pathToFileURL(path.resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js")).href);
  const { ExtensionRunner } = await import(pathToFileURL(path.resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js")).href);
  const { runAgentLoop } = await import(pathToFileURL(path.resolve(repoRoot, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js")).href);
  const runner: any = Object.create(ExtensionRunner.prototype);
  runner.extensions = [{ path: "isolated-control-extension", handlers: new Map(target.handlers), commands: target.commands }];
  runner.createContext = () => target.ctx;
  runner.emitError = vi.fn();
  runner.emitBeforeAgentStart = async () => ({ systemPromptOptions: { selectedTools: [] }, messages: [] });
  const host: any = Object.create(AgentSession.prototype);
  host.agent = { state: { model: { id: "control-fake", provider: "isolated", api: "openai-completions" } } };
  host._isAgentRunActive = false;
  host._runInputHandlers = async (text: string, images: unknown) => ({ text, images });
  host._flushPendingBashMessages = () => {};
  host._flushPendingCustomMessages = () => {};
  host._modelRuntime = { hasConfiguredAuth: () => true, checkAuth: async () => true };
  host.sessionManager = { appendModelChange: vi.fn() };
  host._getThinkingLevelForModelSwitch = () => "xhigh";
  host.setThinkingLevel = vi.fn();
  host._findLastAssistantMessage = () => undefined;
  host._baseSystemPromptOptions = { selectedTools: [] };
  host.getActiveToolNames = () => [];
  host._extensionRunner = runner;
  host._normalizePromptImages = async () => ({ images: [], hints: [] });
  host._pendingNextTurnMessages = [];
  host._preparePromptAndToolLoadout = () => undefined;
  const accepted: string[] = [];
  let providerCalls = 0;
  host._runAgentPrompt = async (messages: any[]) => {
    host._isAgentRunActive = true;
    try {
      await runAgentLoop(messages, { systemPrompt: "", messages: [] }, {
        model: host.agent.state.model, convertToLlm: async (messages: unknown[]) => messages, getApiKey: async () => "fake-only",
      }, async (event: any) => {
        if (event.type === "agent_start") await runner.emit(event);
        if (event.type === "message_end" && event.message.role === "user") {
          accepted.push(event.message.content[0].text);
          await runner.emitMessageEnd(event);
        }
      }, undefined, async () => {
        providerCalls++;
        await providerGate();
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", content: [{ type: "text", text: "Local fixed answer; no model call." }],
          api: "openai-completions", provider: "isolated", model: host.agent.state.model.id,
          stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      });
    } finally {
      host._isAgentRunActive = false;
      await runner.emit({ type: "agent_settled", aborted: false });
    }
  };
  target.ctx.isIdle = () => !host._isAgentRunActive;
  const pending: Promise<unknown>[] = [];
  const direct = (text: string) => host.sendUserMessage(text);
  target.inject = text => { pending.push(direct(text)); };
  return { host, runner, direct, accepted, pending, get providerCalls() { return providerCalls; } };
}

beforeEach(() => {
  const base = process.env.PI_TEAMS_CONTROL_TEST_ROOT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "pi-teams-control-mode-test-"));
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "project"));
  fs.mkdirSync(paths.teamDir(team), { recursive: true });
  fs.mkdirSync(paths.taskDir(team), { recursive: true });
  fs.writeFileSync(paths.configPath(team), JSON.stringify({
    name: team, createdAt: 1, leadSessionId: "control-fixture", leadAgentId: `team-lead@${team}`,
    members: ["team-lead", worker, "peer"].map(name => ({ agentId: `${name}@${team}`, name, agentType: name === "team-lead" ? "lead" : "teammate", joinedAt: 1, cwd: root, subscriptions: [], tmuxPaneId: "", model: "stale/launch-model" })),
  }));
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const controller of waits.splice(0)) controller.abort();
  for (const target of loaded.splice(0)) {
    const handler = target.handlers.get("session_shutdown")?.[0];
    if (handler) await Promise.resolve(handler({ type: "session_shutdown" }, target.ctx)).catch(() => {});
  }
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("local /team-mode command and truthful execution state", () => {
  it("registers discoverable completion/help; no arg and invalid input never change mode", async () => {
    const target = await start(worker, false);
    const registered = target.commands.get("team-mode")!;
    expect(registered.description).toContain("flush");
    expect(registered.getArgumentCompletions("u")).toEqual([{ value: "user", label: "user" }]);
    expect(registered.getArgumentCompletions("nonsense")).toBeNull();
    await command(target); await command(target, "user extra");
    expect(state().mode).toBe("team");
    expect(target.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("Invalid team mode");
    expect(target.sent).toHaveLength(0);
  });

  it.each(["leader", "unbound"] as const)("is unavailable in a %s session, without pretending to own a teammate", async kind => {
    const target = kind === "leader" ? await start("team-lead", false) : load(worker, false);
    await command(target, "user");
    expect(target.ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("Unavailable");
    expect(readControlStateSync(team, worker).mode).toBe("team");
  });

  it("executes the actual installed command during an active provider run, keeps the original session across normal turns", async () => {
    const target = await start(worker, false);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const host = await installedHost(target, () => gate);
    const running = host.direct("human work turn one");
    await drain();
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("running");
    expect(host.providerCalls).toBe(1);
    await host.host.prompt("/team-mode user");
    await host.host.prompt("/team-mode user");
    expect(host.providerCalls).toBe(1);
    expect(state().mode).toBe("user");
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("running");
    resume(); await running;
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("idle");
    await host.host.setModel({ ...host.host.agent.state.model, id: "human-selected-next-model" });
    expect(host.providerCalls).toBe(1);
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("idle");
    await host.direct("human work turn two in the same session");
    expect(host.accepted).toEqual(["human work turn one", "human work turn two in the same session"]);
    expect(host.providerCalls).toBe(2);
    expect(host.runner.emitError).not.toHaveBeenCalled();
    expect(await mail()).toHaveLength(0);
    expect(state().idle).toBeDefined();
    expect(target.ctx.ui.setStatus.mock.calls.some(call => call[0] === "pi-teams-control" && call[1].includes("USER"))).toBe(true);
    await host.host.prompt("/team-mode team");
    expect(host.host.agent.state.model.id).toBe("human-selected-next-model");
    expect(host.providerCalls).toBe(2);
    expect(await mail()).toHaveLength(1);
  });

  it("queues incoming idle mail without starting the user-owned session; direct input and later handback still work", async () => {
    const target = await start(); await turn(target);
    const host = await installedHost(target);
    const pending = await messaging.sendPlainMessage(team, "team-lead", worker, "queued delegated mail", "mail");
    await ticks(3);
    expect(target.sent).toHaveLength(0);
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("idle");
    await host.direct("real human correction");
    expect((await mail(worker, true)).map(message => message.id)).toEqual([pending.id]);
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("idle");
    await command(target, "team");
    await ticks(2); await Promise.all(host.pending);
    expect(target.sent).toHaveLength(1);
    expect(await mail(worker, true)).toHaveLength(0);
  });

  it("linearizes a real in-flight poll before takeover; successful user commit prevents all later idle handoffs", async () => {
    const target = await start(worker, false); await turn(target);
    await messaging.sendPlainMessage(team, "team-lead", worker, "already in flight", "first");
    const unlock = hold(paths.inboxPath(team, worker));
    await ticks(1); // Poll owns the control lock and is waiting on the actual inbox lock.
    let committed = false;
    const takingOver = command(target, "user").then(() => { committed = true; });
    await drain();
    expect(committed).toBe(false);
    expect(target.sent).toHaveLength(0);
    unlock(); await vi.advanceTimersByTimeAsync(200); await takingOver;
    expect(state().mode).toBe("user");
    expect(target.sent).toHaveLength(1); // Already handed to the host, not revocable.
    await messaging.sendPlainMessage(team, "peer", worker, "later pending mail", "second");
    await ticks(3);
    expect(target.sent).toHaveLength(1);
    expect(await mail(worker, true)).toHaveLength(2);
  });

  it("keeps leader idle through repeated user turns/reports but another peer report still activates the actual leader host", async () => {
    const target = await start();
    const lead = await start("team-lead", false); await turn(lead);
    const host = await installedHost(lead);
    await turn(target); await turn(target);
    const held = await execute(target, "team_message", { team_name: team, to: "team-lead", content: "held real work report" });
    expect(held.details.delivery).toBe("held");
    await ticks(2);
    expect(host.providerCalls).toBe(0);
    await messaging.sendPlainMessage(team, "peer", "team-lead", "other peer real result", "real result");
    await ticks(2); await Promise.all(host.pending);
    expect(host.providerCalls).toBe(1);
    expect(host.accepted[0]).toContain("other peer real result");
    await command(target, "flush");
    await ticks(2); await Promise.all(host.pending);
    expect(host.providerCalls).toBe(2);
    expect(host.accepted[1]).toContain("held real work report");
    expect(state().mode).toBe("user");
  });

  it("gives the real prompt current ownership without using stale launch-model metadata as current model proof", async () => {
    const target = await start();
    const event = { type: "before_agent_start", systemPrompt: "base", systemPromptOptions: { sections: { other: "preserve" } } };
    await emit(target, "before_agent_start", event);
    const sections = event.systemPromptOptions.sections as Record<string, string>;
    expect(sections.other).toBe("preserve");
    expect(sections.pi_teams).toContain("Control mode: USER");
    expect(sections.pi_teams).toContain("already-active explicit dependency team_wait");
    expect(sections.pi_teams).not.toContain("You are currently using model: stale/launch-model");
    await command(target, "team");
    await emit(target, "before_agent_start", event);
    expect(sections.pi_teams).toContain("Control mode: TEAM");
    expect(sections.pi_teams).toContain("Stored launch model: stale/launch-model");
    expect(sections.pi_teams).toContain("not proof of the current runtime selection");
    expect(sections.pi_teams).not.toContain("use these exact values");
  });

  it("task_complete commits status while its notice is held, and broadcast splits leader from peers", async () => {
    const target = await start();
    const task = await makeTask();
    const completed = await execute(target, "task_complete", { team_name: team, task_id: task.id, summary: "real task result" });
    expect(completed.details.task.status).toBe("completed");
    const broadcast = await execute(target, "team_message", { team_name: team, to: "all", content: "explicit broadcast" });
    expect(broadcast.details.held).toEqual(["team-lead"]);
    expect(broadcast.details.delivered).toEqual(["peer"]);
    expect((await mail("peer"))[0].text).toBe("explicit broadcast");
    expect(await mail()).toHaveLength(0);
    expect(state().reports).toHaveLength(2);
  });

  it("rejects leader delegation/replacement before orphan tasks, process or model side effects", async () => {
    await start();
    const lead = await start("team-lead", false);
    const before = fs.readFileSync(paths.configPath(team), "utf-8");
    const status = await execute(lead, "check_teammate", { team_name: team, agent_name: worker });
    expect(status.details).toMatchObject({ controlMode: "user", control: { mode: "user", heldReports: 0 } });
    const create = vi.spyOn(tasks, "createTask");
    for (const reuse of ["existing", "replace"]) await expect(execute(lead, "delegate_task", {
      team_name: team, teammate_name: worker, cwd: root, task_subject: "must not exist", task_description: "do not overwrite human work", reuse, model: "forbidden/change",
    })).rejects.toThrow("user-controlled");
    expect(create).not.toHaveBeenCalled();
    expect(await tasks.listTasks(team)).toHaveLength(0);
    expect(fs.readFileSync(paths.configPath(team), "utf-8")).toBe(before);
  });

  it("intentional stop/removal still works, ends ownership, and preserves unflushed report content", async () => {
    const target = await start();
    await execute(target, "team_message", { team_name: team, to: "team-lead", content: "retain before intentional removal" });
    const lead = await start("team-lead", false);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true); // No real signal, including the fixture's own pid.
    await execute(lead, "process_shutdown_approved", { team_name: team, agent_name: worker });
    expect(state()).toMatchObject({ mode: "team", reports: [{ text: "retain before intentional removal" }] });
    expect(state().instanceId).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(paths.configPath(team), "utf-8")).members.some((member: any) => member.name === worker)).toBe(false);
    expect(await mail()).toHaveLength(0);
    expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(true);
  });

  it("does not publish a stale pre-handback idle after task collection was delayed", async () => {
    const target = await start(); await emit(target, "agent_start");
    const original = tasks.listTasks;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let first = true;
    vi.spyOn(tasks, "listTasks").mockImplementation(async (...args) => { if (first) { first = false; await gate; } return original(...args); });
    const settling = emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await drain();
    expect(first).toBe(false);
    await command(target, "team");
    expect(await mail()).toHaveLength(1);
    resume(); await settling;
    expect(await mail()).toHaveLength(1);
  });

  it("coalesces a later run that settles before the actual handback commit, even if the collected snapshot was older", async () => {
    const target = await start(); await turn(target);
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    const handingBack = command(target, "team"); await drain();
    await emit(target, "agent_start");
    const settling = emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await drain();
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("idle");
    unlock(); await vi.advanceTimersByTimeAsync(200);
    await handingBack; await settling;
    expect(await mail()).toHaveLength(1);
    await turn(target);
    expect(await mail()).toHaveLength(2); // A genuinely new team-controlled run.
  });

  it("handback while running permits its later real completion; handing back an interrupted run never resumes it", async () => {
    const target = await start(); await emit(target, "agent_start");
    await command(target, "team");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    expect(await mail()).toHaveLength(2);
    await command(target, "user");
    await turn(target, true);
    const before = (await mail()).length;
    await command(target, "team"); await ticks(2);
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("interrupted");
    expect(target.handlers.has("model_select")).toBe(false);
    expect(target.sent).toHaveLength(0);
    expect(await mail()).toHaveLength(before + 1);
  });

  it("shows an honest release failure and retains pending intent for explicit UI retry", async () => {
    const target = await start();
    await execute(target, "team_message", { team_name: team, to: "team-lead", content: "survive release error" });
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    const flushing = command(target, "team");
    await drain(); await vi.advanceTimersByTimeAsync(5000); await flushing;
    expect(state()).toMatchObject({ mode: "user", reports: [{ text: "survive release error" }] });
    expect(state().release).toBeDefined();
    expect(target.ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("operation failed");
    unlock(); await command(target, "team"); await command(target, "team");
    expect(await mail()).toHaveLength(1);
    expect(state().mode).toBe("team");
  });
});

describe("user ownership preserves wait and inbox obligation policies", () => {
  it("keeps live user-idle peers non-progress-capable but suspends inactivity; explicit timeout and caller abort still work", async () => {
    const target = await start(); await turn(target);
    const lead = await start("team-lead", false); await emit(lead, "agent_start");
    const waiting = execute(lead, "team_wait", { team_name: team, timeout_seconds: 1 });
    await ticks(2);
    const result = await waiting;
    expect(result.details.outcome).toBe("timeout");
    expect(result.details.members.find((member: any) => member.name === worker)).toMatchObject({ controlMode: "user", progressCapable: false, reason: "user_controlled" });
    const controller = new AbortController(); waits.push(controller);
    const cancelled = execute(lead, "team_wait", { team_name: team }, controller.signal).catch((error: unknown) => error);
    await drain(); controller.abort(); await drain();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
  });

  it("stopped or dead user-owned peers do not hold inactivity forever", async () => {
    const target = await start(); await turn(target);
    const lead = await start("team-lead", false); await emit(lead, "agent_start");
    const waiting = execute(lead, "team_wait", { team_name: team });
    await drain();
    await runtime.setRuntimeActivity(team, worker, "idle", { pid: 2147483647 });
    await ticks(4);
    expect((await waiting).details.outcome).toBe("no_active_agents");
    await runtime.setRuntimeActivity(team, worker, "stopped");
    const stopped = execute(lead, "team_wait", { team_name: team });
    await ticks(4);
    expect((await stopped).details.outcome).toBe("no_active_agents");
  });

  it("an already-active explicit dependency wait can consume user-mode mail without idle auto-injection", async () => {
    const target = await start(); await emit(target, "agent_start");
    await runtime.setRuntimeActivity(team, "peer", "running", { pid: process.pid, processStartToken: runtime.getProcessStartToken(process.pid) });
    const dependency = execute(target, "team_wait", { team_name: team, timeout_seconds: 5 });
    await drain();
    await messaging.sendPlainMessage(team, "peer", worker, "dependency answer", "answer");
    await ticks(1);
    expect((await dependency).details.outcome).toBe("message");
    expect(await mail(worker, true)).toHaveLength(0);
    expect(target.sent).toHaveLength(0);
  });

  it("mode switches leave an unknown host attempt single-flight and unread, even after explicit release and a direct run", async () => {
    const target = await start(worker, false); await turn(target);
    const pending = await messaging.sendPlainMessage(team, "team-lead", worker, "unknown host acceptance", "unknown");
    await ticks(1);
    expect(target.sent).toHaveLength(1);
    await command(target, "user"); await command(target, "flush"); await command(target, "team"); await command(target, "user");
    await turn(target); await ticks(60);
    expect(target.sent).toHaveLength(1);
    expect((await mail(worker, true)).map(message => message.id)).toEqual([pending.id]);
    expect((await runtime.readRuntimeStatus(team, worker))?.inboxAwaitingConfirmation?.messageIds).toEqual([pending.id]);
  });

  it("accepted ACK remains metadata-only through user control and transient storage failure", async () => {
    const target = await start(worker, false); await turn(target);
    const host = await installedHost(target);
    const original = messaging.commitInboxAcknowledgement;
    let down = true;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => { if (down) throw new Error("ACK storage down"); return original(...args); });
    await messaging.sendPlainMessage(team, "team-lead", worker, "accepted once", "accepted");
    await ticks(1); await Promise.all(host.pending);
    expect(target.sent).toHaveLength(1);
    expect(await mail(worker, true)).toHaveLength(1);
    await command(target, "user");
    down = false;
    await ticks(2);
    expect(await mail(worker, true)).toHaveLength(0);
    expect(target.sent).toHaveLength(1);
    expect(host.providerCalls).toBe(1);
    expect(state().mode).toBe("user");
  });

  it("real interruption still pauses accepted metadata ACK in user mode until a legitimate direct run", async () => {
    const target = await start(worker, false); await turn(target);
    const host = await installedHost(target);
    const original = messaging.commitInboxAcknowledgement;
    let down = true;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => { if (down) throw new Error("ACK storage down"); return original(...args); });
    await messaging.sendPlainMessage(team, "team-lead", worker, "accepted then aborted", "accepted");
    await ticks(1); await Promise.all(host.pending);
    await command(target, "user"); await turn(target, true);
    down = false; await ticks(3);
    expect(await mail(worker, true)).toHaveLength(1);
    expect((await runtime.readRuntimeStatus(team, worker))?.activity).toBe("interrupted");
    await host.direct("legitimate human resumes the same work session"); await ticks(2);
    expect(await mail(worker, true)).toHaveLength(0);
    expect(target.sent).toHaveLength(1);
    expect(host.providerCalls).toBe(2);
    expect(state().mode).toBe("user");
  });

  it("a fresh extension instance preserves user ownership/reports and rejects the obsolete instance's commands", async () => {
    const old = await start();
    await execute(old, "team_message", { team_name: team, to: "team-lead", content: "previous instance report" });
    const oldId = (await runtime.readRuntimeStatus(team, worker))?.instanceId;
    const fresh = await start(worker, false);
    expect((await runtime.readRuntimeStatus(team, worker))?.instanceId).not.toBe(oldId);
    expect(state()).toMatchObject({ mode: "user", reports: [{ text: "previous instance report" }] });
    await command(old, "team");
    expect(state().mode).toBe("user");
    expect(await mail()).toHaveLength(0);
    expect(old.ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("no longer owns");
    await command(fresh, "team");
    expect((await mail())[0].text).toContain("previous instance report");
    expect(fs.existsSync(controlStatePath(team, worker))).toBe(true);
  });
});
