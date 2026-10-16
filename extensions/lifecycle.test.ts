import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";
import type { Member } from "../src/utils/models";
import * as messaging from "../src/utils/messaging";
import * as paths from "../src/utils/paths";
import {
  readRuntimeStatus,
  replaceRuntimeInstance,
  setRuntimeActivity,
  updateRuntimeStatusForInstance,
  type AgentActivity,
} from "../src/utils/runtime";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
}));

const teamName = "interrupted-wait-regression";
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
  ctx: { isIdle: () => boolean; ui: { notify: () => void; setStatus: () => void; setTitle: () => void } };
}

const loaded: LoadedExtension[] = [];
const pendingWaits: Array<Promise<unknown>> = [];
let abortWaits: AbortController | undefined;
let root = "";

function assertIsolated(target: string) {
  const resolved = path.resolve(target);
  if (resolved === homePi || resolved.startsWith(homePi + path.sep)) {
    throw new Error(`lifecycle test tried to touch ${resolved}`);
  }
}

function member(name: string, agentType = name === "team-lead" ? "lead" : "teammate"): Member {
  return {
    agentId: `${name}@${teamName}`,
    name,
    agentType,
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
    description: "Isolated interruption regression fixture",
    createdAt: 1,
    leadAgentId: "team-lead@interrupted-wait-regression",
    leadSessionId: "lifecycle-test",
    members: [member("team-lead"), member(teammateName), member(workerName)],
  }));
}

function writeTask(owner = teammateName, status = "in_progress") {
  const task = {
    id: "1",
    subject: "Implement interruption-aware wait",
    description: "Preserve ownership while paused",
    status,
    owner,
    blocks: [],
    blockedBy: [],
  };
  fs.writeFileSync(path.join(root, "tasks", teamName, "1.json"), JSON.stringify(task));
  return task;
}

function readTask() {
  return JSON.parse(fs.readFileSync(path.join(root, "tasks", teamName, "1.json"), "utf-8"));
}

async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function loadExtension(agentName: string): LoadedExtension {
  if (!process.env.PI_TEAM_NAME) {
    throw new Error("Refusing to load the extension without an isolated PI_TEAM_NAME");
  }
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
      // Existing lifecycle tests simulate host acceptance. Audit regressions
      // use the real message_end/prompt path instead of this recording stub.
      const handler = handlers.get("message_end")?.[0];
      if (!handler) return;
      void handler({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      }, ctx);
    },
  };
  extension(api as unknown as ExtensionAPI);
  const loadedExtension = { agentName, handlers, tools, sent, ctx };
  loaded.push(loadedExtension);
  return loadedExtension;
}

async function emit(target: LoadedExtension, name: string, event: unknown = { type: name }) {
  const handlers = target.handlers.get(name) ?? [];
  expect(handlers, name).toHaveLength(1);
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

async function pollTicks(times: number) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await drain();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-lifecycle-"));
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
  delete process.env.PI_TEAM_HANDOFF_TOKEN;
  writeTeamConfig();
  vi.useFakeTimers();
});

afterEach(async () => {
  abortWaits?.abort();
  await Promise.allSettled(pendingWaits.splice(0));
  for (const target of loaded.splice(0)) {
    const shutdown = target.handlers.get("session_shutdown")?.[0];
    if (shutdown) {
      await Promise.resolve(shutdown({ type: "session_shutdown" }, target.ctx)).catch(() => undefined);
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  expect(root).not.toContain(`${path.sep}.pi${path.sep}`);
});

describe("registered interruption lifecycle", () => {
  it("publishes interrupted without consuming mail or notifying, with and without an inbox", async () => {
    const teammate = loadExtension(teammateName);
    writeTask();
    const originalTask = readTask();
    await startSession(teammate);
    await emit(teammate, "agent_start");
    await leaveUnread(teammateName, "keep this unread");

    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: true });

    expect(await activityOf(teammateName)).toBe("interrupted");
    expect((await unread(teammateName)).map(message => message.text)).toEqual(["keep this unread"]);
    expect(await unread("team-lead")).toEqual([]);
    expect(readTask()).toEqual(originalTask);
    expect(teammate.sent).toEqual([]);

    const quiet = loadExtension("quiet-worker");
    await startSession(quiet);
    await emit(quiet, "agent_start");
    await emit(quiet, "agent_settled", { type: "agent_settled", aborted: true });

    expect(await activityOf("quiet-worker")).toBe("interrupted");
    expect(await unread("team-lead")).toEqual([]);
    expect(readTask()).toEqual(originalTask);
  });

  it("preserves ordinary idle notification and later delivers mail after a normal settlement", async () => {
    const teammate = loadExtension(teammateName);
    writeTask();
    await startSession(teammate);
    await emit(teammate, "agent_start");
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: false });

    expect(await activityOf(teammateName)).toBe("idle");
    const notice = await unread("team-lead");
    expect(notice).toHaveLength(1);
    expect(notice[0].text).toContain("Agent implementer is idle.");
    expect(notice[0].text).toContain("1 [in_progress] Implement interruption-aware wait");
    expect(readTask().status).toBe("in_progress");
    expect(readTask().owner).toBe(teammateName);

    await leaveUnread(teammateName, "ordinary delivery");
    await pollTicks(2);

    expect(teammate.sent.join("\n")).toContain("ordinary delivery");
    expect(await unread(teammateName)).toEqual([]);
  });

  it("leaves a paused inbox unread across repeated polls and delivers it only after a direct resume", async () => {
    const teammate = loadExtension(teammateName);
    await startSession(teammate);
    await emit(teammate, "agent_start");
    await leaveUnread(teammateName, "paused work");
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: true });

    const reads = vi.spyOn(messaging, "readInbox");
    reads.mockClear();
    await pollTicks(5);

    expect(reads).not.toHaveBeenCalled();
    expect(teammate.sent).toEqual([]);
    expect((await unread(teammateName))[0]).toMatchObject({ text: "paused work", read: false });
    expect(await activityOf(teammateName)).toBe("interrupted");
    reads.mockRestore();

    await emit(teammate, "before_agent_start", {
      type: "before_agent_start",
      prompt: "selecting a model must not resume",
      systemPrompt: "base",
      systemPromptOptions: { sections: {} },
    });
    expect(teammate.handlers.has("model_select")).toBe(false);
    expect(await activityOf(teammateName)).toBe("interrupted");

    await emit(teammate, "agent_start");
    expect(await activityOf(teammateName)).toBe("running");
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: false });
    expect(await activityOf(teammateName)).toBe("queued");
    expect(await unread("team-lead")).toEqual([]);

    await pollTicks(2);
    expect(teammate.sent.join("\n")).toContain("paused work");
    expect(await unread(teammateName)).toEqual([]);
  });

  it("does not let a late settlement overwrite a replacement or stopped lease", async () => {
    const teammate = loadExtension(teammateName);
    await startSession(teammate);
    await emit(teammate, "agent_start");
    const owned = await readRuntimeStatus(teamName, teammateName);
    expect(owned?.instanceId).toEqual(expect.any(String));

    const replaced = await replaceRuntimeInstance(
      teamName,
      teammateName,
      owned!.instanceId!,
      "replacement-instance",
      { activity: "running", pid: process.pid },
    );
    expect(replaced?.instanceId).toBe("replacement-instance");
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: true });
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: false });
    expect(await readRuntimeStatus(teamName, teammateName)).toMatchObject({
      instanceId: "replacement-instance",
      activity: "running",
    });

    const stopping = loadExtension("stopping-worker");
    await startSession(stopping);
    await emit(stopping, "agent_start");
    await emit(stopping, "session_shutdown");
    await emit(stopping, "agent_settled", { type: "agent_settled", aborted: true });
    await emit(stopping, "agent_settled", { type: "agent_settled", aborted: false });
    expect(await activityOf("stopping-worker")).toBe("stopped");
    expect(await unread("team-lead")).toEqual([]);
  });

  it("does not downgrade an interrupted lease to idle when settlement cannot read the inbox", async () => {
    const teammate = loadExtension(teammateName);
    await startSession(teammate);
    await emit(teammate, "agent_start");
    const owned = await readRuntimeStatus(teamName, teammateName);
    await updateRuntimeStatusForInstance(teamName, teammateName, owned!.instanceId!, {
      activity: "interrupted",
    });
    fs.mkdirSync(path.dirname(paths.inboxPath(teamName, teammateName)), { recursive: true });
    fs.writeFileSync(paths.inboxPath(teamName, teammateName), "{");

    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: false });

    expect(await activityOf(teammateName)).toBe("interrupted");
    expect(await unread("team-lead")).toEqual([]);
    expect(fs.readFileSync(paths.inboxPath(teamName, teammateName), "utf-8")).toBe("{");
  });

  it("does not inject or acknowledge when interruption or stop lands during an in-flight poll", async () => {
    const teammate = loadExtension(teammateName);
    await startSession(teammate);
    await emit(teammate, "agent_start");
    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: false });
    await leaveUnread(teammateName, "race me");

    let releaseRead: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    let entered = false;
    const original = messaging.readInbox;
    const readSpy = vi.spyOn(messaging, "readInbox").mockImplementation(async (...args) => {
      if (args[1] === teammateName && args[2] === true && !entered) {
        entered = true;
        await gate;
      }
      return original.apply(messaging, args);
    });

    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 30 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);

    await emit(teammate, "agent_settled", { type: "agent_settled", aborted: true });
    releaseRead();
    await drain();

    expect(teammate.sent.join("\n")).not.toContain("race me");
    expect((await unread(teammateName))[0].read).toBe(false);
    expect(await activityOf(teammateName)).toBe("interrupted");
    readSpy.mockRestore();

    const stopping = loadExtension("stopping-worker");
    await startSession(stopping);
    await emit(stopping, "agent_start");
    await emit(stopping, "agent_settled", { type: "agent_settled", aborted: false });
    await leaveUnread("stopping-worker", "do not resume a stop");
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    let stopEntered = false;
    const stopOriginal = messaging.readInbox;
    const stopSpy = vi.spyOn(messaging, "readInbox").mockImplementation(async (...args) => {
      if (args[1] === "stopping-worker" && args[2] === true && !stopEntered) {
        stopEntered = true;
        await stopGate;
      }
      return stopOriginal.apply(messaging, args);
    });
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 30 && !stopEntered; i++) await Promise.resolve();
    expect(stopEntered).toBe(true);
    const stopPromise = emit(stopping, "session_shutdown");
    releaseStop();
    await stopPromise;
    await drain();
    expect(stopping.sent.join("\n")).not.toContain("do not resume a stop");
    expect((await unread("stopping-worker"))[0].read).toBe(false);
    expect(await activityOf("stopping-worker")).toBe("stopped");
    stopSpy.mockRestore();
  });
});

describe("registered team_wait and messaging tools", () => {
  async function runningLead() {
    const lead = loadExtension("team-lead");
    await startSession(lead);
    await emit(lead, "agent_start");
    return lead;
  }

  async function pausedWorker(activity: AgentActivity = "interrupted", pid = process.pid) {
    await setRuntimeActivity(teamName, workerName, activity, {
      pid,
      activityChangedAt: 1,
      instanceId: "worker-instance",
    });
    await leaveUnread(workerName, "worker still has mail");
  }

  function startWait(lead: LoadedExtension, timeoutSeconds?: number) {
    abortWaits = new AbortController();
    const pending = lead.tools.get("team_wait")!.execute("wait-1", {
      team_name: teamName,
      ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
    }, abortWaits.signal, undefined, { cwd: root });
    pending.catch(() => undefined);
    pendingWaits.push(pending);
    return pending;
  }

  it("exposes a live interrupted peer as not progress-capable and describes the pause", async () => {
    const lead = await runningLead();
    await pausedWorker();

    const checked = await lead.tools.get("check_teammate")!.execute("check-1", {
      team_name: teamName,
      agent_name: workerName,
    }, undefined, undefined, { cwd: root });
    expect(checked.details).toMatchObject({
      name: workerName,
      alive: true,
      activity: "interrupted",
      progressCapable: false,
      stalled: false,
      reason: "interrupted",
      unreadCount: 1,
    });

    const status = await lead.tools.get("team_status")!.execute("status-1", {
      team_name: teamName,
    }, undefined, undefined, { cwd: root });
    expect(status.details.members.find((memberStatus: { name: string }) => memberStatus.name === workerName)).toMatchObject({
      activity: "interrupted",
      progressCapable: false,
      reason: "interrupted",
    });
    expect(lead.tools.get("team_wait")?.description).toContain("interrupted");
    expect(lead.tools.get("check_teammate")?.description).toContain("interrupted");
    expect(lead.tools.get("team_status")?.description).toContain("interrupted");
    expect(lead.tools.get("team_message")?.description).toContain("does not resume an interrupted session");
  });

  it("keeps team_message and broadcast from queueing or resuming an interrupted peer", async () => {
    const lead = await runningLead();
    const worker = loadExtension(workerName);
    await startSession(worker);
    await emit(worker, "agent_start");
    await emit(worker, "agent_settled", { type: "agent_settled", aborted: true });
    const reads = vi.spyOn(messaging, "readInbox");
    reads.mockClear();

    await lead.tools.get("team_message")!.execute("msg-1", {
      team_name: teamName,
      to: workerName,
      content: "stay paused",
    }, undefined, undefined, { cwd: root });
    await lead.tools.get("team_message")!.execute("msg-2", {
      team_name: teamName,
      to: "all",
      content: "broadcast stays paused",
    }, undefined, undefined, { cwd: root });
    await pollTicks(4);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();

    expect(await activityOf(workerName)).toBe("interrupted");
    const pending = await unread(workerName);
    expect(pending.map(message => message.text)).toEqual(["stay paused", "broadcast stays paused"]);
    expect(pending.every(message => message.read === false)).toBe(true);
    expect(worker.sent).toEqual([]);
  });

  it("holds an indefinite tool wait through interrupted polls, then wakes for the final report", async () => {
    const lead = await runningLead();
    await pausedWorker();
    const pending = startWait(lead);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(4000);
    await drain();
    expect(settled).toBe(false);
    expect(await activityOf("team-lead")).toBe("waiting");

    await setRuntimeActivity(teamName, workerName, "running", {
      pid: process.pid,
      instanceId: "worker-instance",
    });
    await vi.advanceTimersByTimeAsync(2000);
    await drain();
    expect(settled).toBe(false);

    await messaging.sendPlainMessage(teamName, workerName, "team-lead", "implementation done", "final report");
    await vi.advanceTimersByTimeAsync(1000);
    await drain();
    const result = await pending;
    expect(result.details.outcome).toBe("message");
    expect(result.details.messages[0].text).toBe("implementation done");
    // readInbox returns the pre-ack objects; the file is acknowledged separately.
    expect(await unread("team-lead")).toEqual([]);
  });

  it("times out while a peer remains interrupted and still aborts on the caller signal", async () => {
    const lead = await runningLead();
    await pausedWorker();
    vi.setSystemTime(0);
    const timed = startWait(lead, 2);
    await vi.advanceTimersByTimeAsync(3000);
    const timeout = await timed;
    expect(timeout.details).toMatchObject({ outcome: "timeout", timedOut: true });
    expect(timeout.details.waitedMs).toBeGreaterThanOrEqual(2000);
    expect(timeout.details.members.find((peer: { name: string }) => peer.name === workerName)).toMatchObject({
      activity: "interrupted",
      progressCapable: false,
      reason: "interrupted",
      unreadCount: 1,
    });

    const abortedLead = await runningLead();
    const controller = new AbortController();
    abortWaits = controller;
    const pending = abortedLead.tools.get("team_wait")!.execute("wait-abort", {
      team_name: teamName,
    }, controller.signal, undefined, { cwd: root });
    const rejected = pending.then(() => {
      throw new Error("team_wait resolved");
    }, (error: unknown) => error);
    pendingWaits.push(pending);
    await Promise.resolve();
    controller.abort();
    await expect(rejected).resolves.toMatchObject({ name: "AbortError" });
  });

  it("permits inactivity once an interrupted peer stops or dies", async () => {
    // Real timers: a runtime-file update can contend with the wait poll, and
    // fake-timer lock retries would deadlock instead of backing off.
    vi.useRealTimers();
    for (const next of ["stopped", "dead"] as const) {
      const lead = await runningLead();
      await pausedWorker();
      const pending = startWait(lead);
      const started = Date.now();
      while (await activityOf("team-lead") !== "waiting") {
        if (Date.now() - started > 2000) throw new Error("team_wait did not enter waiting");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (next === "stopped") {
        await setRuntimeActivity(teamName, workerName, "stopped", {
          pid: process.pid,
          instanceId: "worker-instance",
        });
      } else {
        await setRuntimeActivity(teamName, workerName, "interrupted", {
          pid: 99_999_999,
          instanceId: "worker-instance",
        });
      }
      const result = await pending;
      expect(result.details.outcome).toBe("no_active_agents");
      expect(result.details.members.find((peer: { name: string }) => peer.name === workerName).progressCapable).toBe(false);
    }
  }, 15000);

  it("still detects ordinary all-idle and all-waiting teams", async () => {
    for (const activity of ["idle", "waiting"] as const) {
      const lead = await runningLead();
      await setRuntimeActivity(teamName, workerName, activity, {
        pid: process.pid,
        instanceId: "ordinary-instance",
      });
      const pending = startWait(lead);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.details.outcome).toBe("no_active_agents");
      expect(result.details.members.find((peer: { name: string }) => peer.name === workerName)).toMatchObject({
        activity,
        progressCapable: false,
      });
    }
  });
});
