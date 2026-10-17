import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";
import type { Member } from "../src/utils/models";
import * as messaging from "../src/utils/messaging";
import * as paths from "../src/utils/paths";
import * as runtimeModule from "../src/utils/runtime";
import {
  readRuntimeStatus,
  replaceRuntimeInstance,
  setRuntimeActivity,
  type AgentActivity,
} from "../src/utils/runtime";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
}));

const teamName = "audit-fix-regression";
const teammateName = "implementer";
const workerName = "worker";
const homePi = path.join(os.homedir(), ".pi");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type RegisteredTool = {
  name: string;
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
  ctx: { isIdle: () => boolean; ui: { notify: () => void; setStatus: () => void; setTitle: () => void } };
}

let injectionHook: ((text: string) => void) | undefined;
const loaded: LoadedExtension[] = [];
const pendingWaits: Array<Promise<unknown>> = [];
let abortWaits: AbortController | undefined;
let root = "";

function assertIsolated(target: string) {
  const resolved = path.resolve(target);
  if (resolved === homePi || resolved.startsWith(homePi + path.sep)) {
    throw new Error(`audit test tried to touch ${resolved}`);
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
    description: "Isolated audit-fix fixture",
    createdAt: 1,
    leadAgentId: "team-lead@audit-fix-regression",
    leadSessionId: "audit-fix",
    members: [member("team-lead"), member(teammateName), member(workerName)],
  }));
}

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function loadExtension(agentName: string): LoadedExtension {
  vi.stubEnv("PI_AGENT_NAME", agentName);
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, RegisteredTool>();
  const sent: string[] = [];
  const ctx = {
    isIdle: () => true,
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

function inboxFile(agentName: string) {
  return JSON.parse(fs.readFileSync(paths.inboxPath(teamName, agentName), "utf-8")) as Array<{ read: boolean; text: string }>;
}

async function pollTicks(times: number) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await drain();
  }
}

beforeEach(() => {
  injectionHook = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-audit-fix-"));
  assertIsolated(root);
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(team => path.join(root, "teams", team));
  vi.spyOn(paths, "taskDir").mockImplementation(team => path.join(root, "tasks", team));
  vi.spyOn(paths, "inboxPath").mockImplementation((team, agent) => path.join(root, "teams", team, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((team, agent) => path.join(root, "teams", team, "runtime", `${agent}.json`));
  vi.spyOn(paths, "configPath").mockImplementation(team => path.join(root, "teams", team, "config.json"));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(team => path.join(root, "teams", team, "lead-session.json"));
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", teammateName);
  writeTeamConfig();
  vi.useFakeTimers();
});

afterEach(async () => {
  abortWaits?.abort();
  await Promise.allSettled(pendingWaits.splice(0));
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

function confirm(target: LoadedExtension, text = target.sent[0]) {
  return emit(target, "message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  });
}

async function idleWorker() {
  const target = loadExtension(teammateName);
  await startSession(target);
  await emit(target, "agent_start");
  await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
  return target;
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

function promptHost(
  target: LoadedExtension,
  AgentSession: { prototype: any },
  runAgentLoop: (...args: any[]) => Promise<unknown>,
  inputDelay = 0,
  providerGate?: () => Promise<void>,
) {
  const host: any = Object.create(AgentSession.prototype);
  host.agent = { state: { model: { id: "audit-fake", provider: "audit", api: "openai-completions" } } };
  host._isAgentRunActive = false;
  host._runInputHandlers = async (text: string, images: unknown) => {
    if (inputDelay) await new Promise(resolve => setTimeout(resolve, inputDelay));
    return { text, images };
  };
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
  const accepted: string[] = [];
  let providerCalls = 0;
  host._runAgentPrompt = async (messages: any[]) => {
    host._isAgentRunActive = true;
    try {
      await runAgentLoop(messages, { systemPrompt: "", messages: [] }, {
        model: host.agent.state.model,
        convertToLlm: async (msgs: unknown[]) => msgs,
        getApiKey: async () => "not-a-real-key",
      }, async (event: any) => {
        if (event.type === "agent_start") await emit(target, "agent_start", event);
        if (event.type === "message_end" && event.message.role === "user") {
          accepted.push(event.message.content[0].text);
          await emit(target, "message_end", event);
        }
      }, undefined, async () => {
        providerCalls += 1;
        await providerGate?.();
        throw new Error("audit fake provider: no network");
      });
    } finally {
      host._isAgentRunActive = false;
      await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    }
  };
  target.ctx.isIdle = () => !host._isAgentRunActive;
  const promises: Promise<unknown>[] = [];
  injectionHook = (text) => {
    promises.push(host.sendUserMessage(text).catch((error: Error) => {
      if (!/audit fake provider/.test(error.message)) throw error;
    }));
  };
  return { host, accepted, promises, get providerCalls() { return providerCalls; } };
}

// Use installed handler error containment, not a fixture that assumes a
// throwing agent_start prevents the actual host from accepting direct input.
async function useInstalledRunner(target: LoadedExtension) {
  const mod = await import(pathToFileURL(path.resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
  )).href);
  const runner: any = Object.create(mod.ExtensionRunner.prototype);
  runner.extensions = [{ path: "isolated-pi-teams", handlers: new Map(target.handlers) }];
  runner.createContext = () => target.ctx;
  const errors: Array<{ event: string }> = [];
  runner.emitError = (error: { event: string }) => errors.push(error);
  for (const name of ["agent_start", "agent_settled", "message_end"]) {
    target.handlers.set(name, [(event: any) => name === "message_end" ? runner.emitMessageEnd(event) : runner.emit(event)]);
  }
  return errors;
}

async function pausedAcceptedHost() {
  const target = await idleWorker();
  const first = await leaveUnread(teammateName, "accepted A");
  const { AgentSession, runAgentLoop } = await loadInstalledHost();
  const errors = await useInstalledRunner(target);
  let releaseProvider: (() => void) | undefined;
  let providerHeld = false;
  const host = promptHost(target, AgentSession, runAgentLoop, 0, async () => {
    if (providerHeld) await new Promise<void>(resolve => { releaseProvider = resolve; });
  });
  const originalAck = messaging.commitInboxAcknowledgement;
  let ackDown = true;
  const ack = vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
    if (ackDown) throw new Error("ACK storage down before pause");
    return originalAck(...args);
  });
  await pollTicks(1);
  await Promise.all(host.promises);
  expect(host.accepted).toHaveLength(1);
  await emit(target, "agent_start");
  await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
  expect(await activityOf(teammateName)).toBe("interrupted");
  ackDown = false;
  ack.mockClear();
  return {
    target, first, host, errors, ack,
    holdProvider: () => { providerHeld = true; },
    releaseProvider: () => { providerHeld = false; releaseProvider?.(); },
    direct: () => host.host.sendUserMessage("legitimate direct resume").catch((error: Error) => {
      if (!/audit fake provider/.test(error.message)) throw error;
    }),
  };
}

describe("C4 direct-resume publication recovery", () => {
  it("repairs exactly one failed running publication through the installed host, ACKs A once and progresses backlog", async () => {
    const fixture = await pausedAcceptedHost();
    const { target, first, host, errors, ack } = fixture;
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failures = 0;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "running" && failures === 0) {
        failures += 1;
        throw new Error("exactly one failed running publication");
      }
      return original(...args);
    });
    await fixture.direct();
    expect(host.accepted).toHaveLength(2);
    expect(errors.map(error => error.event)).toEqual(["agent_start"]);
    await pollTicks(3);
    expect(failures).toBe(1);
    expect(await activityOf(teammateName)).toBe("idle");
    expect(await unread(teammateName)).toEqual([]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(target.sent).toHaveLength(1);
    await leaveUnread(teammateName, "backlog B");
    await pollTicks(3);
    await Promise.all(host.promises);
    expect(await unread(teammateName)).toEqual([]);
    expect(target.sent).toHaveLength(2);
    expect(target.sent.filter(text => text.includes(first.id))).toHaveLength(1);
    expect(host.accepted).toHaveLength(3);
  });

  it.each(["active", "settled"] as const)("retains retry intent beyond a finite delay table for an %s direct run", async phase => {
    const fixture = await pausedAcceptedHost();
    if (phase === "active") fixture.holdProvider();
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failures = 0;
    let recovered = false;
    const committed: string[] = [];
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity && !recovered) {
        failures += 1;
        throw new Error("publication unavailable repeatedly");
      }
      const result = await original(...args);
      if (result && args[3].activity) committed.push(args[3].activity);
      return result;
    });
    const direct = fixture.direct();
    await drain();
    await pollTicks(60);
    expect(failures).toBeGreaterThan(10);
    expect(fixture.host.accepted).toHaveLength(2);
    expect(await activityOf(teammateName)).toBe("interrupted");
    expect(fixture.ack).not.toHaveBeenCalled();
    expect(fixture.target.sent).toHaveLength(1);
    recovered = true;
    await pollTicks(6);
    expect(await unread(teammateName)).toEqual([]);
    expect(fixture.ack).toHaveBeenCalledTimes(1);
    expect(await activityOf(teammateName)).toBe(phase === "active" ? "running" : "idle");
    expect(committed).toContain(phase === "active" ? "running" : "queued");
    if (phase === "settled") expect(committed).not.toContain("running");
    fixture.releaseProvider();
    await direct;
  });

  it("invalidates a running retry under the real runtime lock as the host settles normally", async () => {
    const fixture = await pausedAcceptedHost();
    fixture.holdProvider();
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let attempts = 0;
    const committed: string[] = [];
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "running" && ++attempts === 1) throw new Error("first running write fails");
      const result = await original(...args);
      if (result && args[3].activity) committed.push(args[3].activity);
      return result;
    });
    const direct = fixture.direct();
    await drain();
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.writeFileSync(lock, "held runtime");
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    fixture.releaseProvider();
    await drain(); // agent_settled invalidates the running target before reading the lease.
    fs.unlinkSync(lock);
    await pollTicks(5);
    await direct;
    expect(committed).not.toContain("running");
    expect(committed).toContain("queued");
    expect(await activityOf(teammateName)).toBe("idle");
    expect(await unread(teammateName)).toEqual([]);
    expect(fixture.ack).toHaveBeenCalledTimes(1);
    expect(fixture.target.sent).toHaveLength(1);
  });

  it.each(["abort", "stop", "external-stop", "replacement", "new-run"] as const)(
    "does not let a resume retry under the real runtime lock overwrite %s or ACK paused work",
    async next => {
      const fixture = await pausedAcceptedHost();
      const { target, ack } = fixture;
      const original = runtimeModule.updateRuntimeStatusForInstance;
      let unavailable = true;
      let entered = 0;
      const committed: string[] = [];
      vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
        if (args[3].activity && ["running", "queued", "idle"].includes(args[3].activity)) {
          if (unavailable) throw new Error("resume publication temporarily unavailable");
          entered += 1;
        }
        const result = await original(...args);
        if (result && args[3].activity) committed.push(args[3].activity);
        return result;
      });
      await fixture.direct();
      expect(await activityOf(teammateName)).toBe("interrupted");
      const leadMailBefore = await unread("team-lead");
      const taskFile = path.join(paths.taskDir(teamName), "1.json");
      fs.writeFileSync(taskFile, JSON.stringify({ id: "1", owner: teammateName, status: "in_progress" }));
      const taskBefore = fs.readFileSync(taskFile, "utf8");
      const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
      fs.writeFileSync(lock, "held runtime");
      unavailable = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(entered).toBe(1);
      let transition: Promise<unknown>;
      if (next === "replacement" || next === "external-stop") {
        // External lease/state changes obtain the lock before the sleeping old waiter.
        const status = JSON.parse(fs.readFileSync(paths.runtimeStatusPath(teamName, teammateName), "utf8"));
        fs.unlinkSync(lock);
        transition = next === "replacement"
          ? replaceRuntimeInstance(teamName, teammateName, status.instanceId, "replacement", { activity: "waiting" })
          : setRuntimeActivity(teamName, teammateName, "stopped");
      } else {
        transition = next === "stop" ? emit(target, "session_shutdown")
          : next === "abort" ? emit(target, "agent_settled", { type: "agent_settled", aborted: true })
            : emit(target, "agent_start");
        await drain();
        fs.unlinkSync(lock);
      }
      await vi.advanceTimersByTimeAsync(500);
      await transition;
      if (next === "new-run") {
        expect(await activityOf(teammateName)).toBe("running");
        // The old settled target must not mark the newer active run idle/queued.
        expect(committed).toEqual(["running"]);
        await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
      } else {
        expect(committed).not.toContain("running");
        expect(committed).not.toContain("queued");
        expect(committed).not.toContain("idle");
        expect(ack).not.toHaveBeenCalled();
      }
      await pollTicks(20);
      expect(await activityOf(teammateName)).toBe(next === "stop" || next === "external-stop" ? "stopped" : next === "replacement" ? "waiting" : "interrupted");
      expect(target.sent).toHaveLength(1);
      expect(await unread("team-lead")).toEqual(leadMailBefore);
      expect(fs.readFileSync(taskFile, "utf8")).toBe(taskBefore);
      if (next !== "new-run") expect(await unread(teammateName)).toHaveLength(1);
      const after = entered;
      await pollTicks(20);
      expect(entered).toBe(after);
    },
  );

  it.each(["success", "error", "false"] as const)(
    "keeps a newer resume repair when an obsolete retry returns %s late",
    async completion => {
      const fixture = await pausedAcceptedHost();
      const original = runtimeModule.updateRuntimeStatusForInstance;
      let unavailable = true;
      let held = false;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
        const resumeActivity = args[3].activity && ["running", "queued", "idle"].includes(args[3].activity);
        if (resumeActivity && unavailable) throw new Error("resume storage unavailable");
        const result = await original(...args);
        if (resumeActivity && !held) {
          held = true;
          await gate;
          if (completion === "error") throw new Error("obsolete retry completion error");
          if (completion === "false") return null;
        }
        return result;
      });
      await fixture.direct();
      unavailable = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(held).toBe(true);
      expect(fixture.ack).not.toHaveBeenCalled();
      await emit(fixture.target, "agent_settled", { type: "agent_settled", aborted: true });
      unavailable = true;
      await fixture.direct();
      expect(await activityOf(teammateName)).toBe("interrupted");
      release();
      await drain();
      await pollTicks(2);
      expect(await activityOf(teammateName)).toBe("interrupted");
      expect(fixture.ack).not.toHaveBeenCalled();
      unavailable = false;
      await pollTicks(10);
      expect(await activityOf(teammateName)).toBe("idle");
      expect(await unread(teammateName)).toEqual([]);
      expect(fixture.ack).toHaveBeenCalledTimes(1);
      expect(fixture.target.sent).toHaveLength(1);
    },
  );

  it("preserves task ownership after a failed direct start without a routine idle notice", async () => {
    const target = await idleWorker();
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    const before = (await unread("team-lead")).length;
    const taskFile = path.join(paths.taskDir(teamName), "1.json");
    const task = JSON.stringify({ id: "1", subject: "still assigned", owner: teammateName, status: "in_progress" });
    fs.writeFileSync(taskFile, task);
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop);
    await useInstalledRunner(target);
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failed = false;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "running" && !failed) {
        failed = true;
        throw new Error("one failed start");
      }
      return original(...args);
    });
    await host.host.sendUserMessage("direct normal run").catch((error: Error) => {
      if (!/audit fake provider/.test(error.message)) throw error;
    });
    const notices = await unread("team-lead");
    expect(notices).toHaveLength(before);
    expect(notices.some(message => message.text.includes("still assigned"))).toBe(false);
    expect(fs.readFileSync(taskFile, "utf8")).toBe(task);
    expect(await activityOf(teammateName)).toBe("idle");
    await pollTicks(10);
    expect(await unread("team-lead")).toHaveLength(before);
  });

  it("keeps the same unknown attempt unread across a failed direct resume and later polls", async () => {
    const target = await idleWorker();
    const first = await leaveUnread(teammateName, "unknown A");
    await pollTicks(3);
    await emit(target, "agent_settled", { aborted: true });
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop);
    const errors = await useInstalledRunner(target);
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failures = 0;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "running" && failures++ === 0) throw new Error("one running publication failure");
      return original(...args);
    });
    const ack = vi.spyOn(messaging, "commitInboxAcknowledgement");
    await host.host.sendUserMessage("unrelated direct input").catch((error: Error) => {
      if (!/audit fake provider/.test(error.message)) throw error;
    });
    await pollTicks(120);
    expect(errors.map(error => error.event)).toEqual(["agent_start"]);
    expect(host.accepted).toEqual(["unrelated direct input"]);
    expect(target.sent).toHaveLength(1);
    expect(ack).not.toHaveBeenCalled();
    expect((await unread(teammateName)).map(message => message.id)).toEqual([first.id]);
    expect(await activityOf(teammateName)).toBe("queued");
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([first.id]);
    // The original acceptance token remains valid; no replacement object/reset.
    await confirm(target);
    expect(await unread(teammateName)).toEqual([]);
  });
});

describe("audit fix regressions", () => {
  it.each(["interrupted", "stopped", "replacement"] as const)(
    "keeps mail unread when %s lands while acknowledgement waits on the inbox lock",
    async (transition) => {
      const target = await idleWorker();
      await leaveUnread(teammateName, "must not disappear while paused");
      const lock = paths.inboxPath(teamName, teammateName) + ".lock";
      let ackDone: Promise<unknown> = Promise.resolve();
      injectionHook = (text) => {
        fs.writeFileSync(lock, "held", { flag: "wx" });
        const handler = target.handlers.get("message_end")?.[0];
        ackDone = Promise.resolve(handler?.({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
        }, target.ctx));
      };

      await pollTicks(1);
      expect(target.sent).toHaveLength(1);
      expect(fs.existsSync(lock)).toBe(true);
      expect(inboxFile(teammateName)[0].read).toBe(false);

      if (transition === "interrupted") {
        await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
      } else if (transition === "stopped") {
        await emit(target, "session_shutdown");
      } else {
        const lease = await readRuntimeStatus(teamName, teammateName);
        const replaced = await replaceRuntimeInstance(
          teamName,
          teammateName,
          lease!.instanceId!,
          "new-instance",
          { activity: "running", pid: process.pid },
        );
        expect(replaced?.instanceId).toBe("new-instance");
      }

      expect(inboxFile(teammateName)[0].read).toBe(false);
      fs.unlinkSync(lock);
      await vi.advanceTimersByTimeAsync(300);
      await ackDone;
      await drain();

      expect(inboxFile(teammateName)[0].read).toBe(false);
      expect(await activityOf(teammateName)).toBe(transition === "replacement" ? "running" : transition);
      if (transition === "replacement") {
        expect((await readRuntimeStatus(teamName, teammateName))?.instanceId).toBe("new-instance");
      }
    },
  );

  it("rejects the registered wait when cancellation lands during inbox read or acknowledgement", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await emit(lead, "agent_start");
    await leaveUnread("team-lead", "abort must not consume me");
    const controller = new AbortController();
    abortWaits = controller;
    const original = messaging.readInbox;
    vi.spyOn(messaging, "readInbox").mockImplementation(async (...args) => {
      const messages = await original(...args);
      if (args[1] === "team-lead") controller.abort();
      return messages;
    });
    const pending = lead.tools.get("team_wait")!.execute(
      "cancel-read",
      { team_name: teamName },
      controller.signal,
      undefined,
      { cwd: root },
    );
    pendingWaits.push(pending);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await unread("team-lead")).toHaveLength(1);
  });

  it("rejects the registered wait when cancellation lands while the acknowledgement lock is held", async () => {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await emit(lead, "agent_start");
    await leaveUnread("team-lead", "abort must not consume me");
    const controller = new AbortController();
    abortWaits = controller;
    const lock = paths.inboxPath(teamName, "team-lead") + ".lock";
    const original = messaging.readInbox;
    vi.spyOn(messaging, "readInbox").mockImplementation(async (...args) => {
      const messages = await original(...args);
      if (args[1] === "team-lead" && messages.length > 0 && !fs.existsSync(lock)) {
        fs.writeFileSync(lock, "held", { flag: "wx" });
      }
      return messages;
    });
    const originalCommit = messaging.commitInboxAcknowledgement;
    let entered = false;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
      entered = true;
      return originalCommit(...args);
    });
    const pending = lead.tools.get("team_wait")!.execute(
      "cancel-lock",
      { team_name: teamName },
      controller.signal,
      undefined,
      { cwd: root },
    );
    pendingWaits.push(pending.catch(() => undefined));
    for (let i = 0; i < 50 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(inboxFile("team-lead")[0].read).toBe(false);
    controller.abort();
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(inboxFile("team-lead")[0].read).toBe(false);
  });

  it("leaves mail unread when the real host prompt rejects before agent_start", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "cannot be delivered without a selected model");
    const { AgentSession } = await import(pathToFileURL(path.resolve(
      "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
    )).href) as { AgentSession: { prototype: { sendUserMessage: (text: string) => Promise<void> } } };
    const host: any = Object.create(AgentSession.prototype);
    host.agent = { state: { model: undefined } };
    host._isAgentRunActive = false;
    host._runInputHandlers = async (text: string, images: unknown) => ({ text, images });
    host._flushPendingBashMessages = () => {};
    host._flushPendingCustomMessages = () => {};
    const errors: Error[] = [];
    injectionHook = (text) => {
      host.sendUserMessage(text).catch((error: Error) => errors.push(error));
    };

    await pollTicks(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/no model|select a model/i);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
    expect(await activityOf(teammateName)).not.toBe("running");

    await pollTicks(1);
    expect(target.sent).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("acknowledges only the batch whose real user message_end was accepted before any provider call", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "deliver this batch");
    await pollTicks(1);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);

    const { runAgentLoop } = await import(pathToFileURL(path.resolve(
      "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
    )).href) as {
      runAgentLoop: (
        prompts: unknown[],
        context: unknown,
        config: unknown,
        emit: (event: { type: string; message?: { role?: string; content?: unknown } }) => Promise<void>,
        signal: AbortSignal | undefined,
        streamFn: () => Promise<never>,
      ) => Promise<unknown>;
    };
    const events: string[] = [];
    let streamed = false;
    let accepted: { type: string; message: { role: string; content: unknown } } | undefined;
    await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        model: { id: "fake", provider: "fake", api: "openai-completions" },
        convertToLlm: async (messages: unknown[]) => messages,
        getApiKey: async () => "test-key",
      },
      async (event: { type: string; message?: { role?: string; content?: unknown } }) => {
        events.push(`${event.type}:${event.message?.role ?? ""}`);
        if (event.type === "message_end" && event.message?.role === "user") {
          expect(streamed).toBe(false);
          accepted = event as typeof accepted;
        }
      },
      undefined,
      async () => {
        streamed = true;
        throw new Error("no network");
      },
    ).catch((error: Error) => {
      expect(error.message).toMatch(/no network|model/i);
    });

    expect(events).toContain("agent_start:");
    expect(events.indexOf("message_end:user")).toBeGreaterThan(events.indexOf("agent_start:"));
    expect(streamed).toBe(true);
    expect(events.indexOf("message_end:user")).toBeLessThan(events.length);
    const messageEndAt = events.indexOf("message_end:user");
    expect(messageEndAt).toBeGreaterThanOrEqual(0);

    await emit(target, "agent_start");
    await emit(target, "message_end", accepted);
    expect(await unread(teammateName)).toEqual([]);

    await leaveUnread(teammateName, "unrelated");
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "a direct user prompt" }], timestamp: 2 },
    });
    expect((await unread(teammateName)).map(message => message.text)).toEqual(["unrelated"]);
  });

  it("retries a failed interrupted publication without touching inbox mail", async () => {
    const target = loadExtension(teammateName);
    await startSession(target);
    await emit(target, "agent_start");
    await leaveUnread(teammateName, "remain unread");
    const original = runtimeModule.updateRuntimeStatusForInstance;
    const reads = vi.spyOn(messaging, "readInbox");
    reads.mockClear();
    let fail = true;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (fail && args[3].activity === "interrupted") throw new Error("transient write error");
      return original(...args);
    });

    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    expect(await activityOf(teammateName)).toBe("running");
    fail = false;
    reads.mockClear();
    target.sent.length = 0;
    await vi.advanceTimersByTimeAsync(100);
    await drain();

    expect(await activityOf(teammateName)).toBe("interrupted");
    expect(target.sent).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(await unread(teammateName)).toHaveLength(1);
    expect(await unread("team-lead")).toEqual([]);
  });

  it("does not let stop, resume, or replacement overwrite a pending interrupted publication", async () => {
    const target = loadExtension(teammateName);
    await startSession(target);
    await emit(target, "agent_start");
    await leaveUnread(teammateName, "remain unread");
    const runtimeLock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.mkdirSync(path.dirname(runtimeLock), { recursive: true });
    fs.writeFileSync(runtimeLock, "held", { flag: "wx" });

    const settling = emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    settling.catch(() => undefined);
    await drain();
    const stopping = emit(target, "session_shutdown");
    stopping.catch(() => undefined);
    await drain();
    fs.unlinkSync(runtimeLock);
    await vi.advanceTimersByTimeAsync(500);
    await settling;
    await stopping;
    expect(await activityOf(teammateName)).toBe("stopped");
    expect(inboxFile(teammateName)[0].read).toBe(false);

    const resumed = loadExtension("resumed-worker");
    await startSession(resumed);
    await emit(resumed, "agent_start");
    const resumedLock = paths.runtimeStatusPath(teamName, "resumed-worker") + ".lock";
    fs.mkdirSync(path.dirname(resumedLock), { recursive: true });
    fs.writeFileSync(resumedLock, "held", { flag: "wx" });
    const pausing = emit(resumed, "agent_settled", { type: "agent_settled", aborted: true });
    pausing.catch(() => undefined);
    await drain();
    const starting = emit(resumed, "agent_start");
    starting.catch(() => undefined);
    await drain();
    fs.unlinkSync(resumedLock);
    await vi.advanceTimersByTimeAsync(500);
    await pausing;
    await starting;
    expect(await activityOf("resumed-worker")).toBe("running");

    const replaced = loadExtension("replaced-worker");
    await startSession(replaced);
    await emit(replaced, "agent_start");
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let fail = true;
    const spy = vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (fail && args[3].activity === "interrupted") throw new Error("transient write error");
      return original(...args);
    });
    await emit(replaced, "agent_settled", { type: "agent_settled", aborted: true });
    fail = false;
    spy.mockRestore();
    const lease = await readRuntimeStatus(teamName, "replaced-worker");
    await replaceRuntimeInstance(teamName, "replaced-worker", lease!.instanceId!, "new-instance", {
      activity: "running",
      pid: process.pid,
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await readRuntimeStatus(teamName, "replaced-worker")).toMatchObject({
      instanceId: "new-instance",
      activity: "running",
    });
  });

  it("accepts a slow real host preflight once despite later polls", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "one work item");
    const notices: string[] = [];
    (target.ctx.ui as { notify: (message?: string) => void }).notify = (message?: string) => {
      notices.push(message ?? "");
    };
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop, 3500);
    await pollTicks(8);
    await Promise.all(host.promises);
    expect(host.accepted).toHaveLength(1);
    expect(host.providerCalls).toBe(1);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toEqual([]);
    expect(notices.join("\n")).toContain("Acceptance is unknown");
    expect(notices.join("\n")).not.toMatch(/delivery failed/i);
  });

  it("does not resend a handled or rejected unknown attempt across minutes or an unrelated run", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "input pending");
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const handled = promptHost(target, AgentSession, runAgentLoop);
    handled.host._runInputHandlers = async () => undefined;
    await pollTicks(1);
    expect(handled.accepted).toEqual([]);
    await vi.advanceTimersByTimeAsync(180_000);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(3);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);

    const errors: Error[] = [];
    handled.host._runInputHandlers = async () => { throw new Error("input preflight rejected"); };
    injectionHook = (text) => {
      handled.host.sendUserMessage(text).catch((error: Error) => errors.push(error));
    };
    await pollTicks(3);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(target.sent).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(await unread(teammateName)).toHaveLength(1);
  });

  it("does not resend a rejected input preflight after minutes or an unrelated run", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "input rejected");
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop);
    const errors: Error[] = [];
    host.host._runInputHandlers = async () => {
      throw new Error("input preflight rejected");
    };
    injectionHook = (text) => {
      host.host.sendUserMessage(text).catch((error: Error) => errors.push(error));
    };
    await pollTicks(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(host.accepted).toEqual([]);
    await vi.advanceTimersByTimeAsync(180_000);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(2);
    expect(target.sent).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
  });

  it("keeps no-model mail unread and does not inject another copy", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "cannot be delivered without a selected model");
    const { AgentSession } = await loadInstalledHost();
    const host: any = Object.create(AgentSession.prototype);
    host.agent = { state: { model: undefined } };
    host._isAgentRunActive = false;
    host._runInputHandlers = async (text: string, images: unknown) => ({ text, images });
    host._flushPendingBashMessages = () => {};
    host._flushPendingCustomMessages = () => {};
    const errors: Error[] = [];
    injectionHook = (text) => {
      host.sendUserMessage(text).catch((error: Error) => errors.push(error));
    };
    await pollTicks(1);
    await vi.advanceTimersByTimeAsync(180_000);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(2);
    expect(errors).toHaveLength(1);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
    const status = await readRuntimeStatus(teamName, teammateName);
    expect(status?.inboxAwaitingConfirmation?.messageIds).toEqual([(await messaging.readInbox(teamName, teammateName, false, false))[0].id]);
    expect(status?.inboxAwaitingConfirmation?.note).toContain("not a confirmed failure");
    expect(status?.activity).not.toBe("idle");
  });

  it("acknowledges only the confirmed batch after the diagnostic and then delivers the next one", async () => {
    const target = await idleWorker();
    const first = await leaveUnread(teammateName, "first");
    await leaveUnread(teammateName, "second");
    await pollTicks(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(target.sent).toHaveLength(1);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([first.id]);
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    expect((await unread(teammateName)).map(message => message.text)).toEqual(["second"]);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation).toBeUndefined();
    await pollTicks(1);
    expect(target.sent).toHaveLength(2);
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[1] }], timestamp: 2 },
    });
    expect(await unread(teammateName)).toEqual([]);
  });

  it("does not acknowledge or go idle when confirmation arrives after interruption", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "paused confirm");
    await pollTicks(1);
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    await pollTicks(4);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
    expect(await activityOf(teammateName)).toBe("interrupted");
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(3);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
  });

  it("retries a failed acknowledgement without injecting the accepted prompt again", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "retry ack");
    await pollTicks(1);
    const original = messaging.commitInboxAcknowledgement;
    let failures = 0;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
      failures += 1;
      if (failures === 1) throw new Error("write failure");
      return original(...args);
    });
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    expect(await unread(teammateName)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await drain();
    expect(failures).toBeGreaterThan(1);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toEqual([]);
  });

  it.each(["resume", "stop", "replacement"] as const)(
    "does not let a stale interrupted retry waiting on the runtime lock overwrite %s",
    async (next) => {
      const target = loadExtension(teammateName);
      await startSession(target);
      await emit(target, "agent_start");
      await leaveUnread(teammateName, "remain unread");
      const original = runtimeModule.updateRuntimeStatusForInstance;
      let fail = true;
      vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
        if (fail && args[3].activity === "interrupted") throw new Error("transient");
        return original(...args);
      });
      await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
      fail = false;
      const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, "held", { flag: "wx" });
      await vi.advanceTimersByTimeAsync(100);
      const raw = JSON.parse(fs.readFileSync(paths.runtimeStatusPath(teamName, teammateName), "utf-8"));
      const changed = next === "resume"
        ? emit(target, "agent_start")
        : next === "stop"
          ? emit(target, "session_shutdown")
          : replaceRuntimeInstance(teamName, teammateName, raw.instanceId, "replacement", {
            activity: "running",
            pid: process.pid,
          });
      fs.unlinkSync(lock);
      await vi.advanceTimersByTimeAsync(600);
      await changed;
      expect(await activityOf(teammateName)).toBe(next === "stop" ? "stopped" : "running");
      if (next === "replacement") {
        expect((await readRuntimeStatus(teamName, teammateName))?.instanceId).toBe("replacement");
      }
      expect(await unread(teammateName)).toHaveLength(1);
      expect(target.sent).toEqual([]);
    },
  );

  it("does not let an old interrupted retry clear a newer run's pending interrupted publication", async () => {
    const target = loadExtension(teammateName);
    await startSession(target);
    await emit(target, "agent_start");
    await leaveUnread(teammateName, "remain unread");
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let attempts = 0;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "interrupted") {
        attempts += 1;
        if (attempts === 1 || attempts === 3) throw new Error("transient write failure");
      }
      return original(...args);
    });
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    expect(attempts).toBe(1);
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held", { flag: "wx" });
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    fs.unlinkSync(lock);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await activityOf(teammateName)).toBe("interrupted");
    expect(await unread(teammateName)).toHaveLength(1);
    expect(target.sent).toEqual([]);
  });

  it("does not let a stale interrupted retry undo a newer successful publication", async () => {
    const target = loadExtension(teammateName);
    await startSession(target);
    await emit(target, "agent_start");
    await leaveUnread(teammateName, "remain unread");
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failures = 0;
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].activity === "interrupted" && failures === 0) {
        failures += 1;
        throw new Error("transient write failure");
      }
      return original(...args);
    });
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held", { flag: "wx" });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(50);
    fs.unlinkSync(lock);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    expect(await activityOf(teammateName)).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await activityOf(teammateName)).toBe("interrupted");
    await pollTicks(3);
    expect(target.sent).toEqual([]);
    expect(await unread(teammateName)).toHaveLength(1);
  });

  it.each(["confirmation", "timer"] as const)(
    "recovers real malformed inbox ACK and fallback reads from %s without rejection or resend",
    async boundary => {
      const target = await idleWorker();
      const first = await leaveUnread(teammateName, "accepted before corruption");
      const second = await leaveUnread(teammateName, "backlog");
      await pollTicks(1);
      const file = paths.inboxPath(teamName, teammateName);
      const valid = fs.readFileSync(file, "utf8");
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      const read = vi.spyOn(messaging, "readInbox");
      const commit = vi.spyOn(messaging, "commitInboxAcknowledgement");
      try {
        if (boundary === "timer") {
          commit.mockRejectedValueOnce(new Error("first ACK unavailable"));
          await confirm(target);
        }
        fs.writeFileSync(file, "{transient malformed inbox");
        if (boundary === "confirmation") await expect(confirm(target)).resolves.toBeUndefined();
        // Keep it corrupt through detached timer retries as well as confirmation.
        await vi.advanceTimersByTimeAsync(700);
        expect(commit.mock.calls.length).toBeGreaterThan(1);
        expect(read.mock.calls.length).toBeGreaterThan(1);
        fs.writeFileSync(file, valid);
        await pollTicks(10);
        expect(unhandled).toEqual([]);
        expect((await unread(teammateName)).map(message => message.id)).toEqual([second.id]);
        expect(target.sent.filter(text => text.includes(first.id))).toHaveLength(1);
        expect(target.sent).toHaveLength(2);
        await confirm(target, target.sent[1]);
        expect(await unread(teammateName)).toEqual([]);
      } finally {
        if (fs.readFileSync(file, "utf8").startsWith("{transient")) fs.writeFileSync(file, valid);
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it("replaces stale accepted diagnostic after storage recovery and rejects its delayed cleanup under the runtime lock", async () => {
    const target = await idleWorker();
    const first = await leaveUnread(teammateName, "accepted old diagnostic");
    const second = await leaveUnread(teammateName, "current unknown diagnostic");
    const statuses: Array<string | undefined> = [];
    target.ctx.ui.setStatus = ((key: string, value: string | undefined) => {
      if (key === "pi-teams-delivery") statuses.push(value);
    }) as typeof target.ctx.ui.setStatus;
    await pollTicks(3);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([first.id]);
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let failClears = true;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (failClears && Object.hasOwn(args[3], "inboxAwaitingConfirmation") && args[3].inboxAwaitingConfirmation === undefined) {
        throw new Error("diagnostic clear temporarily unavailable");
      }
      if (args[3].lastInboxReadAt && !entered) {
        entered = true;
        await gate;
      }
      return original(...args);
    });
    const finishing = confirm(target);
    for (let i = 0; i < 200 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    expect((await unread(teammateName)).map(message => message.id)).toEqual([second.id]);
    await pollTicks(1); // B starts while A's accepted diagnostic still exists.
    expect(target.sent).toHaveLength(2);
    failClears = false;
    await pollTicks(3);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([second.id]);
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.writeFileSync(lock, "delay old cleanup at real runtime lock");
    release();
    await drain();
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(100);
    await finishing;
    await pollTicks(10);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([second.id]);
    expect(statuses.at(-1)).toContain(second.id);
    expect(target.sent).toHaveLength(2);
  });

  it("rechecks the current resume after an older guarded false ACK completion was delayed", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "accepted ACK paused");
    await pollTicks(1);
    const original = messaging.commitInboxAcknowledgement;
    let attempts = 0;
    let reachedFalse = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("initial ACK failure");
      const result = await original(...args);
      if (attempts === 2) {
        expect(result).toBe(0);
        reachedFalse = true;
        await gate;
      }
      return result;
    });
    await confirm(target);
    const lock = paths.inboxPath(teamName, teammateName) + ".lock";
    fs.writeFileSync(lock, "held inbox");
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { aborted: true });
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(100);
    expect(reachedFalse).toBe(true);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { aborted: false });
    await pollTicks(2);
    expect(attempts).toBe(2); // Resume coalesces with, rather than duplicates, in-flight work.
    release();
    await drain();
    await pollTicks(10);
    expect(await unread(teammateName)).toEqual([]);
    expect(target.sent).toHaveLength(1);
  });

  it.each(["resume", "reabort", "stop", "replacement"] as const)(
    "preserves ACK recovery ownership when real old lock waiter beats running publication then %s",
    async next => {
      const target = await idleWorker();
      await leaveUnread(teammateName, "accepted before pause");
      const original = messaging.commitInboxAcknowledgement;
      let attempts = 0;
      let lastResult: number | undefined;
      vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("first ACK failure");
        const result = await original(...args);
        lastResult = result;
        return result;
      });
      const { AgentSession, runAgentLoop } = await loadInstalledHost();
      const host = promptHost(target, AgentSession, runAgentLoop);
      await pollTicks(1);
      await Promise.all(host.promises);
      expect(host.accepted).toHaveLength(1);
      const inboxLock = paths.inboxPath(teamName, teammateName) + ".lock";
      const runtimeLock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
      fs.writeFileSync(inboxLock, "held inbox");
      await vi.advanceTimersByTimeAsync(100); // t1100: old ACK waits on inbox.
      expect(attempts).toBe(2);
      await emit(target, "agent_start");
      await emit(target, "agent_settled", { aborted: true });
      expect(await activityOf(teammateName)).toBe("interrupted");
      await vi.advanceTimersByTimeAsync(50);
      fs.writeFileSync(runtimeLock, "held runtime");
      fs.unlinkSync(inboxLock); // t1150.
      await vi.advanceTimersByTimeAsync(50); // t1200: old ACK now waits runtime.
      await vi.advanceTimersByTimeAsync(50);
      const resuming = emit(target, "agent_start"); // t1250: start retries t1350.
      await drain();
      await vi.advanceTimersByTimeAsync(49);
      fs.unlinkSync(runtimeLock);
      await vi.advanceTimersByTimeAsync(1); // t1300: old ACK wins, sees interrupted.
      expect(lastResult).toBe(0);
      if (next === "reabort") await emit(target, "agent_settled", { aborted: true });
      if (next === "stop") await emit(target, "session_shutdown");
      if (next === "replacement") {
        const lease = await readRuntimeStatus(teamName, teammateName);
        await replaceRuntimeInstance(teamName, teammateName, lease!.instanceId!, "next-owner", { activity: "idle" });
      }
      await vi.advanceTimersByTimeAsync(50);
      await resuming;
      if (next === "resume") {
        expect(await activityOf(teammateName)).toBe("running");
        await emit(target, "agent_settled", { aborted: false });
      }
      await pollTicks(10);
      expect(await unread(teammateName)).toHaveLength(next === "resume" ? 0 : 1);
      expect(await activityOf(teammateName)).toBe(next === "resume" ? "idle" : next === "reabort" ? "interrupted" : next === "stop" ? "stopped" : "idle");
      const settledAttempts = attempts;
      await pollTicks(10);
      expect(attempts).toBe(settledAttempts); // No retry chain after lease loss/pause.
      expect(host.accepted).toHaveLength(1);
      expect(target.sent).toHaveLength(1);
    },
  );

  it("resumes metadata-only acknowledgement after an accepted batch is paused", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "accepted");
    await leaveUnread(teammateName, "later");
    const commit = messaging.commitInboxAcknowledgement;
    let fail = true;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
      if (fail) throw new Error("ack storage down");
      return commit(...args);
    });
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop);
    await pollTicks(1);
    await Promise.all(host.promises);
    expect(host.accepted).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(2);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    fail = false;
    await pollTicks(2);
    expect(await unread(teammateName)).toHaveLength(2);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await unread(teammateName)).map(message => message.text)).toEqual([]);
    expect(host.accepted.filter(text => text.includes("accepted"))).toHaveLength(1);
    expect(target.sent.filter(text => text.includes("later"))).toHaveLength(1);
  });

  it("resumes metadata-only acknowledgement after interruption wins the inbox lock", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "accepted while lock held");
    await pollTicks(1);
    const lock = paths.inboxPath(teamName, teammateName) + ".lock";
    fs.writeFileSync(lock, "held", { flag: "wx" });
    await emit(target, "agent_start");
    const confirming = emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    await drain();
    await emit(target, "agent_settled", { type: "agent_settled", aborted: true });
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(200);
    await confirming;
    expect(await unread(teammateName)).toHaveLength(1);
    await emit(target, "agent_start");
    await emit(target, "agent_settled", { type: "agent_settled", aborted: false });
    await pollTicks(10);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toEqual([]);
  });

  it("clears the unknown diagnostic when acceptance is known even if acknowledgement keeps failing", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "late confirmation");
    await pollTicks(3);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation).toBeDefined();
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockRejectedValue(new Error("storage down"));
    await emit(target, "agent_start");
    await emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(target.sent).toHaveLength(1);
    expect(await unread(teammateName)).toHaveLength(1);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation).toBeUndefined();
    expect((await readRuntimeStatus(teamName, teammateName))?.lastError?.message ?? "").not.toMatch(/unknown/i);
  });

  it("does not let a pending unknown writer publish after confirmation or clear a later attempt", async () => {
    const target = await idleWorker();
    const first = await leaveUnread(teammateName, "first");
    await pollTicks(1);
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held", { flag: "wx" });
    await vi.advanceTimersByTimeAsync(1500);
    const confirming = emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    await drain();
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(300);
    await confirming;
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation).toBeUndefined();
    expect(first.id).toEqual(expect.any(String));
  });

  it("does not let an older accepted cleanup clear a newer diagnostic", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "first");
    const second = await leaveUnread(teammateName, "second");
    await pollTicks(1);
    const original = runtimeModule.updateRuntimeStatusForInstance;
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      if (args[3].lastInboxReadAt && !entered) {
        entered = true;
        await gate;
      }
      return original(...args);
    });
    const finishing = emit(target, "message_end", {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: target.sent[0] }], timestamp: 1 },
    });
    for (let i = 0; i < 200 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    await pollTicks(3);
    expect(target.sent).toHaveLength(2);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([second.id]);
    release();
    await finishing;
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([second.id]);
  });

  it("does not let old acknowledgement metadata erase a newer diagnostic after runtime lock contention", async () => {
    const target = await idleWorker();
    await leaveUnread(teammateName, "first");
    const second = await leaveUnread(teammateName, "second");
    const lock = paths.runtimeStatusPath(teamName, teammateName) + ".lock";
    const originalCommit = messaging.commitInboxAcknowledgement;
    let attempts = 0;
    vi.spyOn(messaging, "commitInboxAcknowledgement").mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("first ACK fails during the real accepted run");
      const marked = await originalCommit(...args);
      if (attempts === 2) fs.writeFileSync(lock, "held after metadata-only ACK retry");
      return marked;
    });
    const { AgentSession, runAgentLoop } = await loadInstalledHost();
    const host = promptHost(target, AgentSession, runAgentLoop);
    await pollTicks(1);
    await Promise.all(host.promises);
    expect(host.accepted).toHaveLength(1);
    expect(await activityOf(teammateName)).toBe("queued");
    const originalRuntime = runtimeModule.updateRuntimeStatusForInstance;
    const published: string[][] = [];
    vi.spyOn(runtimeModule, "updateRuntimeStatusForInstance").mockImplementation(async (...args) => {
      const result = await originalRuntime(...args);
      if (result && args[3].inboxAwaitingConfirmation) {
        published.push([...args[3].inboxAwaitingConfirmation.messageIds]);
      }
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fs.existsSync(lock)).toBe(true);
    await vi.advanceTimersByTimeAsync(899);
    fs.unlinkSync(lock);
    injectionHook = (text) => {
      host.host._runInputHandlers = async () => undefined;
      void host.host.sendUserMessage(text);
      fs.writeFileSync(lock, "held after second injection");
    };
    await vi.advanceTimersByTimeAsync(1);
    expect(target.sent).toHaveLength(2);
    expect(fs.existsSync(lock)).toBe(true);
    await vi.advanceTimersByTimeAsync(1499);
    fs.unlinkSync(lock);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(published).toEqual([[second.id]]);
    expect((await readRuntimeStatus(teamName, teammateName))?.inboxAwaitingConfirmation?.messageIds).toEqual([second.id]);
  });
});
