import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import * as atomic from "./atomic-file";
import * as messaging from "./messaging";
import * as tasks from "./tasks";
import { claimMemberControl, enterUserControl, releaseControlReports, retireMemberControl } from "./control";
import { controlStatePath, readControlStateSync, withMemberControl, type MemberControlState } from "./control-state";
import { readRuntimeStatus, replaceRuntimeInstance, setRuntimeActivity } from "./runtime";

const team = "control-routing";
const worker = "worker";
const instance = "worker-instance";
let root = "";
let generation = 1;
let settled = true;
let activity: "idle" | "running" = "idle";

const state = () => readControlStateSync(team, worker);
const inbox = (name = "team-lead") => messaging.readInbox(team, name, false, false);
const send = (text: string, options: messaging.ReportOptions = {}) => messaging.sendPlainMessage(
  team, worker, "team-lead", text, text, undefined, { instanceId: instance, ...options },
);
const release = (action: "team" | "flush" = "team", overrides: Partial<Parameters<typeof releaseControlReports>[0]> = {}) => releaseControlReports({
  teamName: team, agentName: worker, instanceId: instance, action, allow: () => true,
  getSnapshot: async () => ({ activity, generation, settled, tasks: await tasks.listTasks(team) }),
  getRunState: () => ({ generation, settled }),
  ...overrides,
});
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function hold(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".lock", "held by regression fixture", { flag: "wx" });
  return () => fs.unlinkSync(file + ".lock");
}
function failNextReleaseCleanup() {
  const original = atomic.atomicWriteJsonSync;
  let fail = true;
  vi.spyOn(atomic, "atomicWriteJsonSync").mockImplementation((file, value) => {
    const control = value as MemberControlState;
    if (file === controlStatePath(team, worker) && fail && control.lastReleaseFingerprint && !control.release) {
      fail = false; throw new Error("outbox cleanup filesystem error");
    }
    return original(file, value);
  });
}
async function ownedTask() {
  const task = await tasks.createTask(team, "Outstanding work", "Do not infer completion from idle");
  return tasks.assignTask(team, task.id, worker, { assignedBy: "team-lead", status: "in_progress", notifyOwner: false });
}

beforeEach(async () => {
  const base = process.env.PI_TEAMS_CONTROL_TEST_ROOT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "pi-teams-control-mode-test-"));
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "team"));
  vi.spyOn(paths, "taskDir").mockReturnValue(path.join(root, "tasks"));
  vi.spyOn(paths, "configPath").mockReturnValue(path.join(root, "team", "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((_team, agent) => path.join(root, "team", "inboxes", `${agent}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((_team, agent) => path.join(root, "team", "runtime", `${agent}.json`));
  vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "project"));
  fs.mkdirSync(paths.teamDir(team), { recursive: true });
  fs.mkdirSync(paths.taskDir(team), { recursive: true });
  fs.writeFileSync(paths.configPath(team), JSON.stringify({ name: team, members: ["team-lead", worker, "peer"].map(name => ({ name })) }));
  vi.useFakeTimers();
  generation = 1; settled = true; activity = "idle";
  await claimMemberControl(team, worker, instance, () => setRuntimeActivity(team, worker, "idle", { instanceId: instance }));
  await enterUserControl(team, worker, instance, () => true);
});

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable user-control leader-report routing", () => {
  it("holds explicit reports, coalesces only idle snapshots, and leaves truthful activity alone", async () => {
    await send("meaningful progress, not completion");
    for (let i = 0; i < 20; i++) await send(`idle snapshot ${i}`, { kind: "idle", generation });
    expect((await inbox())).toHaveLength(0);
    expect(state().reports.map(report => report.text)).toEqual(["meaningful progress, not completion"]);
    expect(state().idle?.text).toBe("idle snapshot 19");
    expect((await readRuntimeStatus(team, worker))?.activity).toBe("idle");
  });

  it("holds only the broadcast leader recipient; peer dependencies still deliver", async () => {
    const direct = await messaging.sendPlainMessage(team, worker, "peer", "dependency", "dependency", undefined, { instanceId: instance });
    const broadcast = await messaging.broadcastMessage(team, worker, "broadcast result", "result", undefined, { instanceId: instance });
    expect(direct.delivery).toBe("delivered");
    expect(broadcast).toEqual({ delivered: ["peer"], held: ["team-lead"], failed: [] });
    expect((await inbox("peer")).map(message => message.text)).toEqual(["dependency", "broadcast result"]);
    expect(await inbox()).toHaveLength(0);
  });

  it("releases original reports with latest task state, never claims idle means done", async () => {
    const task = await ownedTask();
    const report = await send("progress only: tests remain");
    await send("latest idle", { kind: "idle", generation });
    await release();
    const [batch] = await inbox();
    expect(batch.releaseReportIds).toEqual([report.id]);
    expect(batch.text).toContain("progress only: tests remain");
    expect(batch.text).toContain(`${task.id} [in_progress]`);
    expect(batch.text).toContain("Handback is NOT task completion");
    expect(batch.text).toContain("latest idle");
    expect(state()).toMatchObject({ mode: "team", reports: [] });
    expect(state().idle).toBeUndefined();
    expect(state().release).toBeUndefined();
    expect((await tasks.readTask(team, task.id)).status).toBe("in_progress");
  });

  it("sends one honest empty handback, keeps mode calls idempotent, and suppresses only the old settled idle", async () => {
    await ownedTask();
    await enterUserControl(team, worker, instance, () => true);
    await release(); await release();
    expect(await inbox()).toHaveLength(1);
    expect((await inbox())[0].text).toContain("No completion report was provided");
    expect((await send("old idle", { kind: "idle", generation })).delivery).toBe("suppressed");
    expect((await send("new idle", { kind: "idle", generation: 2 })).delivery).toBe("delivered");
    expect(await inbox()).toHaveLength(2);
  });

  it("flush keeps user mode; repeated unchanged flush is empty, new reports and handback remain real events", async () => {
    await send("first report");
    await release("flush"); await release("flush");
    expect(state().mode).toBe("user");
    expect(await inbox()).toHaveLength(1);
    await send("new result after flush");
    await release("flush");
    expect(await inbox()).toHaveLength(2);
    await release("team"); await release("team");
    expect(await inbox()).toHaveLength(3);
    expect(state().mode).toBe("team");
  });

  it("handback while still running does not suppress that run's later normal completion", async () => {
    activity = "running"; settled = false;
    await setRuntimeActivity(team, worker, "running", { instanceId: instance });
    await release();
    expect(state().suppressIdle).toBeUndefined();
    await setRuntimeActivity(team, worker, "idle", { instanceId: instance });
    expect((await send("the running job really settled", { kind: "idle", generation })).delivery).toBe("delivered");
    expect(await inbox()).toHaveLength(2);
  });

  it("routes a report queued behind the actual runtime/control locks using committed user ownership, not a stale team snapshot", async () => {
    await release();
    const initialInboxIds = (await inbox()).map(message => message.id);
    const unlock = hold(paths.runtimeStatusPath(team, worker));
    const entering = enterUserControl(team, worker, instance, () => true);
    await drain();
    const queuedReport = send("queued behind takeover commit");
    await drain();
    expect(state().mode).toBe("team");
    unlock(); await vi.advanceTimersByTimeAsync(200);
    await entering;
    expect((await queuedReport).delivery).toBe("held");
    expect((await inbox()).map(message => message.id)).toEqual(initialInboxIds);
    expect(state().reports.map(report => report.text)).toEqual(["queued behind takeover commit"]);
  });

  it("persists a pending batch before a real mailbox-lock timeout and retries exactly once", async () => {
    await send("must survive failed release");
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    const attempt = release().catch(error => error);
    await drain();
    expect(state().release?.message.id).toEqual(expect.any(String));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await attempt).toBeInstanceOf(Error);
    const savedId = state().release!.message.id;
    expect(state()).toMatchObject({ mode: "user", reports: [{ text: "must survive failed release" }] });
    unlock();
    await release();
    expect((await inbox()).map(message => message.id)).toEqual([savedId]);
    expect(state().mode).toBe("team");
  });

  it("dedupes an already-read batch when mailbox append committed but outbox cleanup failed without phantom queue", async () => {
    await setRuntimeActivity(team, "team-lead", "idle");
    await send("durable report");
    failNextReleaseCleanup();
    await expect(release()).rejects.toThrow("outbox cleanup");
    const savedId = state().release!.message.id;
    expect((await inbox())[0].id).toBe(savedId);
    await messaging.readInbox(team, "team-lead", false, true);
    await setRuntimeActivity(team, "team-lead", "idle");
    const retry = await release(); await release();
    expect(retry.batches).toBe(1); // Finalized cleanup is not newly queued work.
    expect((await inbox()).map(message => message.id)).toEqual([savedId]);
    expect((await inbox())[0].read).toBe(true);
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("idle");
  });

  it("queues a still-unread persisted release when cleanup failed before the original queue signal", async () => {
    await setRuntimeActivity(team, "team-lead", "idle");
    await send("unread report survives the failed cleanup");
    failNextReleaseCleanup();
    await expect(release()).rejects.toThrow("outbox cleanup");
    const savedId = state().release!.message.id;
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("idle");
    const retry = await release();
    expect(retry.batches).toBe(1);
    expect((await inbox()).map(message => ({ id: message.id, read: message.read }))).toEqual([{ id: savedId, read: false }]);
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("queued");
  });

  it.each([false, true])("keeps old and new batches separate after cleanup failure; old receipt read=%s", async readOld => {
    await setRuntimeActivity(team, "team-lead", "idle");
    const first = await send("first before failed cleanup");
    failNextReleaseCleanup();
    await expect(release()).rejects.toThrow("outbox cleanup");
    const savedId = state().release!.message.id;
    if (readOld) await messaging.readInbox(team, "team-lead", true, true);
    const second = await send("new while old cleanup remains pending");
    const retry = await release();
    expect(retry.batches).toBe(2);
    const history = await inbox();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: savedId, read: readOld, releaseReportIds: [first.id] });
    expect(history[0].text).not.toContain(second.text);
    expect(history[1]).toMatchObject({ read: false, releaseReportIds: [second.id] });
    expect(history[1].text).toContain(second.text);
    expect(state()).toMatchObject({ mode: "team", reports: [] });
    expect(state().release).toBeUndefined();
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("queued");
  });

  it("rechecks receipt consumption after dedupe but before queue signalling", async () => {
    await setRuntimeActivity(team, "team-lead", "idle");
    await send("consume during snapshot collection");
    failNextReleaseCleanup();
    await expect(release()).rejects.toThrow("outbox cleanup");
    await release("team", { getSnapshot: async () => {
      expect(await messaging.readInbox(team, "team-lead", true, true)).toHaveLength(1);
      await setRuntimeActivity(team, "team-lead", "idle");
      return { activity, generation, settled, tasks: [] };
    } });
    expect((await inbox())[0].read).toBe(true);
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("idle");
  });

  it("keeps the actual inbox locked through the recipient runtime queue commit", async () => {
    await setRuntimeActivity(team, "team-lead", "idle");
    await send("queue while this exact batch remains unread");
    const unlock = hold(paths.runtimeStatusPath(team, "team-lead"));
    const releasing = release(); await drain();
    const inboxLockedWhileRuntimeWaits = fs.existsSync(paths.inboxPath(team, "team-lead") + ".lock");
    let consumed = false;
    const consuming = messaging.readInbox(team, "team-lead", true, true).then(messages => { consumed = true; return messages; });
    await drain();
    const consumedBeforeQueueCommit = consumed;
    unlock(); await vi.advanceTimersByTimeAsync(200);
    await releasing;
    expect(await consuming).toHaveLength(1);
    expect(inboxLockedWhileRuntimeWaits).toBe(true);
    expect(consumedBeforeQueueCommit).toBe(false);
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("queued");
    await setRuntimeActivity(team, "team-lead", "idle");
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("idle");
  });

  it("does not duplicate delivery when only the final mode save failed", async () => {
    await send("saved report");
    const original = atomic.atomicWriteJsonSync;
    let fail = true;
    vi.spyOn(atomic, "atomicWriteJsonSync").mockImplementation((file, value) => {
      if (file === controlStatePath(team, worker) && fail && (value as MemberControlState).mode === "team") {
        fail = false; throw new Error("final mode save failed");
      }
      return original(file, value);
    });
    await expect(release()).rejects.toThrow("final mode save");
    expect(state().mode).toBe("user");
    expect(await inbox()).toHaveLength(1);
    await release();
    expect(state().mode).toBe("team");
    expect(await inbox()).toHaveLength(1);
  });

  it("does not erase or fold a concurrent new report into an already-prepared batch", async () => {
    await send("first");
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    const releasing = release("flush");
    await drain();
    const sending = send("concurrent second");
    await drain();
    expect(state().release?.reportIds).toHaveLength(1);
    unlock();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([releasing, sending]);
    expect((await inbox())[0].text).not.toContain("concurrent second");
    expect(state().reports.map(report => report.text)).toEqual(["concurrent second"]);
    await release("flush");
    expect(await inbox()).toHaveLength(2);
    expect((await inbox())[1].text).toContain("concurrent second");
  });

  it("serializes handback followed by a new user switch without stale completion changing mode", async () => {
    await send("prior report");
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    const releasing = release();
    await drain();
    const takingOver = enterUserControl(team, worker, instance, () => true);
    unlock();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([releasing, takingOver]);
    expect(state().mode).toBe("user");
    expect(await inbox()).toHaveLength(1);
    expect((await send("later user work")).delivery).toBe("held");
  });

  it.each(["stop", "replacement", "shutdown"] as const)("retains reports and rejects release when %s wins under the real inbox lock", async reason => {
    await send("must not escape obsolete lease");
    const unlock = hold(paths.inboxPath(team, "team-lead"));
    let alive = true;
    const releasing = release("team", { allow: () => alive }).catch(error => error);
    await drain();
    if (reason === "stop") await setRuntimeActivity(team, worker, "stopped", { instanceId: instance });
    else if (reason === "replacement") await replaceRuntimeInstance(team, worker, instance, "new-instance", { activity: "idle" });
    else alive = false;
    unlock();
    await vi.advanceTimersByTimeAsync(100);
    expect(await releasing).toBeInstanceOf(Error);
    expect(await inbox()).toHaveLength(0);
    expect(state().mode).toBe("user");
    expect(state().reports).toHaveLength(1);
    expect(state().release).toBeDefined();
  });

  it("does not steal a live control owner after 30 seconds of a genuinely held asynchronous operation", async () => {
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const owner = withMemberControl(team, worker, async control => { await gate; control.state.mode = "user"; control.save(); });
    await drain();
    await vi.advanceTimersByTimeAsync(31_000);
    const competing = send("must not steal live control").catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await competing).toBeInstanceOf(Error);
    expect(await inbox()).toHaveLength(0);
    resume(); await owner;
    expect((await send("safe explicit retry")).delivery).toBe("held");
  });

  it("reclaims a stale dead owner's control lock without dropping ownership or reports", async () => {
    await send("persisted before crashed process");
    const file = `${controlStatePath(team, worker)}.lock`;
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: "dead-owner" }));
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(file, stale, stale);
    await release();
    expect(state().mode).toBe("team");
    expect((await inbox())[0].text).toContain("persisted before crashed process");
  });

  it("fences an obsolete release after lock replacement so its callback cannot erase newer reports", async () => {
    await send("older pending content");
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const releasing = release("team", { getSnapshot: async () => { await gate; return { activity, generation, settled, tasks: [] }; } }).catch(error => error);
    await drain();
    // Forced lock loss, e.g. external operator intervention. The old nonce must
    // not let its async completion commit or remove a newer owner's lock.
    fs.unlinkSync(`${controlStatePath(team, worker)}.lock`);
    await enterUserControl(team, worker, instance, () => true);
    await send("newer pending content");
    resume();
    expect(await releasing).toBeInstanceOf(Error);
    expect(state().mode).toBe("user");
    expect(state().reports.map(report => report.text)).toEqual(["older pending content", "newer pending content"]);
    expect(await inbox()).toHaveLength(0);
  });

  it("retains explicit ownership and reports across a new runtime instance; old callbacks cannot report", async () => {
    await send("from previous process");
    await claimMemberControl(team, worker, "fresh-instance", () => setRuntimeActivity(team, worker, "starting", { instanceId: "fresh-instance" }));
    expect(JSON.parse(fs.readFileSync(controlStatePath(team, worker), "utf-8")).mode).toBe("user");
    expect((await send("old callback")).delivery).toBe("suppressed");
    await messaging.sendPlainMessage(team, worker, "team-lead", "fresh report", "fresh report", undefined, { instanceId: "fresh-instance" });
    await release("team", { instanceId: "fresh-instance" });
    expect((await inbox())[0].text).toContain("from previous process");
    expect((await inbox())[0].text).toContain("fresh report");
    expect((await inbox())[0].text).not.toContain("old callback");
  });

  it("intentional retirement ends ownership but preserves pending reports until explicit release by a replacement", async () => {
    await send("unflushed before intentional stop");
    await setRuntimeActivity(team, worker, "stopped", { instanceId: instance });
    await withMemberControl(team, worker, async control => retireMemberControl(control));
    expect(state()).toMatchObject({ mode: "team", reports: [{ text: "unflushed before intentional stop" }] });
    expect(state().instanceId).toBeUndefined();
    await claimMemberControl(team, worker, "replacement", () => setRuntimeActivity(team, worker, "idle", { instanceId: "replacement" }));
    expect(await inbox()).toHaveLength(0);
    await release("flush", { instanceId: "replacement" });
    expect((await inbox())[0].text).toContain("unflushed before intentional stop");
  });

  it.each(["{malformed", JSON.stringify({ version: 1, mode: "user", reports: [{ id: "missing-content" }] })])(
    "fails closed on malformed control state instead of silently delivering a held report (%s)", async malformed => {
      fs.writeFileSync(controlStatePath(team, worker), malformed);
      await expect(send("do not leak")).rejects.toThrow();
      expect(await inbox()).toHaveLength(0);
      expect(fs.readFileSync(controlStatePath(team, worker), "utf-8")).toBe(malformed);
    },
  );
});

describe("task completion remains a real durable task commit", () => {
  function hook(exit: 0 | 1) {
    const file = path.join(root, "project", ".pi", "team-hooks", "task_completed.sh");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/bash\nexit ${exit}\n`);
    fs.chmodSync(file, 0o700);
  }

  it("runs the actual completion hook and holds its notification without changing completed status", async () => {
    const task = await ownedTask();
    hook(0);
    const completed = await tasks.completeTask(team, task.id, { completedBy: worker, summary: "actual tests passed", instanceId: instance });
    expect(completed.status).toBe("completed");
    expect(state().reports.map(report => report.id)).toEqual([completed.completionNotice!.id]);
    expect(await inbox()).toHaveLength(0);
    await release();
    expect((await inbox())[0].text).toContain("actual tests passed");
    expect((await inbox())[0].text).toContain(`${task.id} [completed]`);
  });

  it("a failing actual hook still vetoes completion and creates no success notice", async () => {
    const task = await ownedTask();
    hook(1);
    await expect(tasks.completeTask(team, task.id, { completedBy: worker, instanceId: instance })).rejects.toThrow("hook");
    expect((await tasks.readTask(team, task.id))).toMatchObject({ status: "in_progress" });
    expect((await tasks.readTask(team, task.id)).completionNotice).toBeUndefined();
    expect(state().reports).toHaveLength(0);
  });

  it.each(["team", "flush"] as const)("dedupes a completion notice whose original send was queued behind %s recovery", async action => {
    const task = await ownedTask();
    let collect!: () => void;
    const snapshotGate = new Promise<void>(resolve => { collect = resolve; });
    const releasing = release(action, {
      getSnapshot: async () => {
        await snapshotGate;
        return { activity, generation, settled, tasks: await tasks.listTasks(team) };
      },
    });
    await drain(); // Release owns the real control lock before completion commits.
    const completing = tasks.completeTask(team, task.id, {
      completedBy: worker, summary: "committed while release owns control", instanceId: instance,
    });
    await drain();
    const committed = await tasks.readTask(team, task.id);
    expect(committed.status).toBe("completed");
    expect(committed.completionNotice?.id).toEqual(expect.any(String));
    expect(state().reports).toHaveLength(0); // Original send is still waiting on control.
    collect(); await releasing;
    await messaging.readInbox(team, "team-lead", false, true); // Leader can consume the batch before original send gets control.
    await setRuntimeActivity(team, "team-lead", "idle");
    await vi.advanceTimersByTimeAsync(200); await completing;
    expect((await readRuntimeStatus(team, "team-lead"))?.activity).toBe("idle");
    await release("flush"); await release("flush");
    expect(await inbox()).toHaveLength(1);
    expect((await inbox())[0].releaseReportIds).toContain(committed.completionNotice!.id);
    expect((await inbox())[0].read).toBe(true);
    expect(state().reports).toHaveLength(0);
  });

  it.each([false, true])("recovers durable completion-notification intent after initial send error, even if reassigned (%s)", async reassign => {
    const task = await ownedTask();
    const fail = vi.spyOn(messaging, "sendPlainMessage").mockRejectedValueOnce(new Error("notification write failed after task commit"));
    await expect(tasks.completeTask(team, task.id, { completedBy: worker, summary: "completed before notification error", instanceId: instance })).rejects.toThrow("notification write");
    fail.mockRestore();
    const committed = await tasks.readTask(team, task.id);
    expect(committed.status).toBe("completed");
    expect(committed.completionNotice?.id).toEqual(expect.any(String));
    expect(state().reports).toHaveLength(0);
    if (reassign) await tasks.updateTask(team, task.id, { owner: "peer" }, { updatedBy: "team-lead", notifyOwner: false });
    await release(); await release("flush");
    expect(await inbox()).toHaveLength(1);
    expect((await inbox())[0].releaseReportIds).toContain(committed.completionNotice!.id);
    expect((await inbox())[0].text).toContain("completed before notification error");
  });
});
