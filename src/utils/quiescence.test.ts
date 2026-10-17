// Project: pi-teams
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acknowledgeAcceptedInspection,
  admitQuiescenceInspection,
  formatInspection,
  noteInspectionAccepted,
  openFormalGeneration,
  QUIESCENCE_MARKER,
  quiescenceGate,
  readQuiescenceState,
  releaseAcceptedInspection,
} from "./quiescence";
import { appendMessageOnce, readInbox } from "./messaging";
import * as paths from "./paths";
import { setRuntimeActivity } from "./runtime";

const teamName = "quiescence-unit";
const leadName = "team-lead";
const workerName = "worker-1";
const secondWorkerName = "worker-2";
const testDir = path.join(os.tmpdir(), `pi-teams-quiescence-unit-${process.pid}`);

const alwaysAlive = { isMemberAlive: () => true };

function teamRoot(): string {
  return path.join(testDir, "teams", teamName);
}

function writeConfig() {
  fs.mkdirSync(teamRoot(), { recursive: true });
  fs.mkdirSync(path.join(testDir, "tasks", teamName), { recursive: true });
  fs.writeFileSync(path.join(teamRoot(), "config.json"), JSON.stringify({
    name: teamName,
    description: "quiescence unit fixture",
    createdAt: 1,
    leadAgentId: "team-lead@quiescence-unit",
    leadSessionId: "unit",
    members: [
      { agentId: "team-lead@quiescence-unit", name: leadName, agentType: "lead", joinedAt: 1, tmuxPaneId: "", cwd: testDir, subscriptions: [] },
      { agentId: `worker-1@quiescence-unit`, name: workerName, agentType: "teammate", joinedAt: 1, tmuxPaneId: "", cwd: testDir, subscriptions: [] },
      { agentId: `worker-2@quiescence-unit`, name: secondWorkerName, agentType: "teammate", joinedAt: 1, tmuxPaneId: "", cwd: testDir, subscriptions: [] },
    ],
  }));
}

async function setIdle(agentName: string, instanceId = `instance-${agentName}`) {
  await setRuntimeActivity(teamName, agentName, "idle", {
    instanceId,
    pid: process.pid,
    startedAt: 1,
    activityChangedAt: 1,
    lastHeartbeatAt: 1,
  });
}

async function allIdle() {
  await setIdle(leadName);
  await setIdle(workerName);
  await setIdle(secondWorkerName);
}

async function leadUnread() {
  return readInbox(teamName, leadName, true, false);
}

async function leaveUnread(agentName: string, text: string) {
  return appendMessageOnce(teamName, agentName, {
    id: `msg-${agentName}-${text}`,
    from: "tester",
    text,
    timestamp: new Date(0).toISOString(),
    read: false,
    summary: text,
  });
}

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  vi.spyOn(paths, "teamDir").mockImplementation(() => teamRoot());
  vi.spyOn(paths, "taskDir").mockImplementation(() => path.join(testDir, "tasks", teamName));
  vi.spyOn(paths, "configPath").mockImplementation(() => path.join(teamRoot(), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((_team, agent) => path.join(teamRoot(), "inboxes", `${agent}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((_team, agent) => path.join(teamRoot(), "runtime", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(() => path.join(teamRoot(), "lead-session.json"));
  writeConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe("team quiescence watermark", () => {
  it("does not admit an inspection without a formal generation", async () => {
    await allIdle();
    const result = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(result).toMatchObject({ admitted: false, reason: "checked" });
    expect(await leadUnread()).toEqual([]);
  });

  it("admits one inspection for an unchecked generation and keeps it single-flight", async () => {
    await allIdle();
    expect(await openFormalGeneration(teamName)).toBe(1);

    const first = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(first.admitted).toBe(true);
    expect(first.generation).toBe(1);
    expect(first.messageId).toEqual(expect.any(String));

    const messages = await leadUnread();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(first.messageId);
    expect(messages[0].text).toContain(QUIESCENCE_MARKER);
    expect(messages[0].text).toContain("Generation: 1");
    expect(messages[0].text).toContain("not task completion");
    expect(messages[0].text).toContain("delegate_task");

    const second = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(second).toMatchObject({ admitted: false, reason: "in-flight", messageId: first.messageId });
    expect(await leadUnread()).toHaveLength(1);
  });

  it("does not check a generation without an accepted tagged inspection", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);

    const noInspection = await acknowledgeAcceptedInspection(teamName, {
      messageId: "other",
      leaderInstanceId: "instance-lead",
      runGeneration: 3,
    });
    expect(noInspection.checked).toBe(false);
    expect(noInspection.checkedGeneration).toBe(0);

    const wrongTag = await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 3,
      deliveredText: `Message-ID: ${admitted.messageId}\nGeneration: 999`,
    });
    expect(wrongTag.accepted).toBe(false);

    const wrongIds = await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 3,
      deliveredText: "some other user message\nGeneration: 1",
    });
    expect(wrongIds.accepted).toBe(false);

    const afterBogus = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 3,
    });
    expect(afterBogus.checked).toBe(false);
    expect((await readQuiescenceState(teamName)).checkedGeneration).toBe(0);
  });

  it("checks only the accepted generation on its matching settlement", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    const delivered = `Message-ID: ${admitted.messageId}\n${(await leadUnread())[0].text}`;

    const accepted = await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
      deliveredText: delivered,
    });
    expect(accepted).toMatchObject({ accepted: true, generation: 1 });

    const wrongRun = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 8,
    });
    expect(wrongRun.checked).toBe(false);

    const checked = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
    });
    expect(checked).toMatchObject({ checked: true, generation: 1, checkedGeneration: 1, currentGeneration: 1 });
    expect((await readQuiescenceState(teamName)).inspection).toBeUndefined();
  });

  it("releases an accepted inspection on abort without checking it", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 4,
      deliveredText: `Message-ID: ${admitted.messageId}\n${(await leadUnread())[0].text}`,
    });

    const released = await releaseAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 4,
    });
    expect(released).toBe(true);

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(state.inspection).toBeUndefined();

    // The old unread copy still blocks a duplicate, and only after the lead
    // consumes it can a fresh inspection be created for the same generation.
    await setIdle(leadName);
    const blocked = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(blocked).toMatchObject({ admitted: false, reason: "team-lead has pending mail" });
    await readInbox(teamName, leadName, true, true);
    const fresh = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(fresh.admitted).toBe(true);
    expect(fresh.messageId).not.toBe(admitted.messageId);
  });

  it("coalesces a newer generation into the pending tagged message", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(admitted.generation).toBe(1);

    // The append queued the lead for delivery; simulate the narrow window where
    // the lead is idle again with the pending message still unread.
    await setIdle(leadName);
    expect(await openFormalGeneration(teamName)).toBe(2);
    const retagged = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(retagged).toMatchObject({ admitted: false, reason: "in-flight", generation: 2, messageId: admitted.messageId });

    const messages = await leadUnread();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("Generation: 2");

    await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 5,
      deliveredText: `Message-ID: ${admitted.messageId}\n${messages[0].text}`,
    });
    const checked = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 5,
    });
    expect(checked).toMatchObject({ checked: true, generation: 2, checkedGeneration: 2 });
  });

  it("does not admit while a member is starting, queued, running, waiting, interrupted, or unknown", async () => {
    await allIdle();
    for (const activity of ["starting", "queued", "running", "waiting", "interrupted"] as const) {
      await openFormalGeneration(teamName);
      await setRuntimeActivity(teamName, workerName, activity, { instanceId: "instance-worker-1" });
      const result = await admitQuiescenceInspection(teamName, alwaysAlive);
      expect(result.admitted, activity).toBe(false);
      expect(result.reason, activity).toContain(workerName);
      await setIdle(workerName);
    }

    fs.rmSync(path.join(teamRoot(), "runtime", `${workerName}.json`));
    const unknown = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(unknown.admitted).toBe(false);
    expect(unknown.reason).toContain("unknown");
  });

  it("does not admit with pending mail or unknown inbox acceptance", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    await leaveUnread(workerName, "worker has mail");
    const pending = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(pending).toMatchObject({ admitted: false, reason: `${workerName} has pending mail` });

    await readInbox(teamName, workerName, true, true);
    await setRuntimeActivity(teamName, workerName, "idle", {
      instanceId: "instance-worker-1",
      inboxAwaitingConfirmation: { messageIds: ["x"], since: 1, note: "unknown" },
    });
    const unknownAcceptance = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(unknownAcceptance).toMatchObject({ admitted: false, reason: `${workerName} has unknown inbox acceptance` });
  });

  it("exposes stopped and dead members as faults instead of silent success", async () => {
    await setIdle(leadName);
    await setRuntimeActivity(teamName, workerName, "stopped", { instanceId: "instance-worker-1" });
    fs.rmSync(path.join(teamRoot(), "runtime", `${secondWorkerName}.json`), { force: true });
    await openFormalGeneration(teamName);

    const liveness = {
      isMemberAlive: (_team: string, member: { name: string }) => member.name !== secondWorkerName,
    };
    const admitted = await admitQuiescenceInspection(teamName, liveness);
    expect(admitted.admitted).toBe(true);
    const message = (await leadUnread())[0];
    expect(message.text).toContain("worker-1 is stopped");
    expect(message.text).toContain("worker-2 is dead");
  });

  it("formats an inspection without inventing completion", async () => {
    const text = formatInspection({
      leadName,
      members: [
        { name: leadName, agentType: "lead", alive: true, activity: "idle", unreadCount: 0, unreadIds: [], awaitingConfirmation: false },
        { name: workerName, agentType: "teammate", alive: true, activity: "idle", unreadCount: 0, unreadIds: [], awaitingConfirmation: false },
      ],
      tasks: [{ id: "1", subject: "unfinished", status: "in_progress", owner: workerName }],
    }, 3, []);
    expect(text).toContain("Generation: 3");
    expect(text).toContain("1 [in_progress] owner=worker-1 unfinished");
    expect(text).toContain("does not mark any task complete");
    expect(text).not.toMatch(/completed by|success/i);
  });

  it("keeps the reserved id across an append failure and retries without duplication", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const failingStore = vi.fn(async () => {
      throw new Error("inbox storage unavailable");
    });
    await expect(admitQuiescenceInspection(teamName, alwaysAlive, { store: failingStore }))
      .rejects.toThrow("inbox storage unavailable");

    const reserved = (await readQuiescenceState(teamName)).inspection;
    expect(reserved).toMatchObject({ generation: 1, phase: "reserved" });
    expect(await leadUnread()).toEqual([]);

    const retried = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(retried).toMatchObject({ admitted: true, reason: "retry", messageId: reserved!.messageId });
    const messages = await leadUnread();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(reserved!.messageId);

    const again = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(again).toMatchObject({ admitted: false, reason: "in-flight" });
    expect(await leadUnread()).toHaveLength(1);
  });

  it("appends once by id and fails loudly on corrupt state", async () => {
    const first = await appendMessageOnce(teamName, leadName, {
      id: "fixed-id",
      from: "a",
      text: "one",
      timestamp: new Date(0).toISOString(),
      read: false,
    });
    const second = await appendMessageOnce(teamName, leadName, {
      id: "fixed-id",
      from: "a",
      text: "two",
      timestamp: new Date(0).toISOString(),
      read: false,
    });
    expect(second.text).toBe("one");
    expect(await leadUnread()).toHaveLength(1);
    expect(first.id).toBe("fixed-id");

    fs.writeFileSync(path.join(teamRoot(), "quiescence.json"), "{not json");
    await expect(openFormalGeneration(teamName)).rejects.toThrow();
  });

  it("treats a non-idle participant as blocking the check", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    await setRuntimeActivity(teamName, leadName, "running", { instanceId: "instance-lead" });
    const result = await admitQuiescenceInspection(teamName, alwaysAlive);
    expect(result).toMatchObject({ admitted: false, reason: `${leadName} is running` });
    expect(await leadUnread()).toEqual([]);
  });

  it("reports false for an idle team with no live participant", async () => {
    const gate = quiescenceGate({
      leadName,
      members: [
        { name: leadName, agentType: "lead", alive: false, activity: "idle", unreadCount: 0, unreadIds: [], awaitingConfirmation: false },
      ],
      tasks: [],
    });
    expect(gate.quiescent).toBe(false);
    expect(gate.reason).toBe("no live idle participant");
  });

  it("a stale release cannot delete a newer inspection record", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const first = await admitQuiescenceInspection(teamName, alwaysAlive);
    const delivered = `Message-ID: ${first.messageId}\n${(await leadUnread())[0].text}`;
    await noteInspectionAccepted(teamName, {
      messageId: first.messageId!,
      leaderInstanceId: "leader-1",
      runGeneration: 1,
      deliveredText: delivered,
    });

    // Simulate a replacement leader that dropped the stale record and accepted
    // a newer inspection before the old process's release retry ran.
    const newer = { generation: 2, messageId: "newer-message", phase: "accepted", leaderInstanceId: "leader-2", runGeneration: 9 };
    const filePath = path.join(teamRoot(), "quiescence.json");
    const state = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    state.generation = 2;
    state.inspection = newer;
    fs.writeFileSync(filePath, JSON.stringify(state));

    const released = await releaseAcceptedInspection(teamName, {
      messageId: first.messageId!,
      leaderInstanceId: "leader-1",
      runGeneration: 1,
    });
    expect(released).toBe(false);
    const after = await readQuiescenceState(teamName);
    expect(after.inspection?.messageId).toBe("newer-message");
    expect(after.checkedGeneration).toBe(0);
  });

  it("reports false when the accepted record is already gone", async () => {
    const released = await releaseAcceptedInspection(teamName, {
      messageId: "already-gone",
      leaderInstanceId: "leader-1",
      runGeneration: 1,
    });
    expect(released).toBe(false);
  });

  it("revalidates authority at the commit boundary before checking", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
      deliveredText: `Message-ID: ${admitted.messageId}\n${(await leadUnread())[0].text}`,
    });

    let guardCalls = 0;
    const blocked = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
    }, { stillAuthorized: () => { guardCalls += 1; return false; } });
    expect(guardCalls).toBe(1);
    expect(blocked).toMatchObject({ checked: false, checkedGeneration: 0 });
    expect((await readQuiescenceState(teamName)).inspection?.phase).toBe("accepted");

    const committed = await acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
    }, { stillAuthorized: () => true });
    expect(committed).toMatchObject({ checked: true, generation: 1, checkedGeneration: 1 });
    expect((await readQuiescenceState(teamName)).inspection).toBeUndefined();
  });

  it("propagates a guard error without changing the record", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
      deliveredText: `Message-ID: ${admitted.messageId}\n${(await leadUnread())[0].text}`,
    });

    await expect(acknowledgeAcceptedInspection(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
    }, { stillAuthorized: () => { throw new Error("authority read failed"); } }))
      .rejects.toThrow("authority read failed");

    const state = await readQuiescenceState(teamName);
    expect(state.checkedGeneration).toBe(0);
    expect(state.inspection?.phase).toBe("accepted");
  });

  it("reports why a commit was rejected so the caller can keep ownership", async () => {
    await allIdle();
    await openFormalGeneration(teamName);
    const admitted = await admitQuiescenceInspection(teamName, alwaysAlive);
    await noteInspectionAccepted(teamName, {
      messageId: admitted.messageId!,
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
      deliveredText: `Message-ID: ${admitted.messageId}\n${(await leadUnread())[0].text}`,
    });
    const input = { messageId: admitted.messageId!, leaderInstanceId: "instance-lead", runGeneration: 7 };

    const revoked = await acknowledgeAcceptedInspection(teamName, input, { stillAuthorized: () => "revoked" });
    expect(revoked).toMatchObject({ checked: false, decision: "revoked", checkedGeneration: 0 });

    const notOurs = await acknowledgeAcceptedInspection(teamName, input, { stillAuthorized: () => "not-ours" });
    expect(notOurs).toMatchObject({ checked: false, decision: "not-ours" });

    // Boolean false keeps the original Q2 meaning: the obligation was revoked.
    const booleanFalse = await acknowledgeAcceptedInspection(teamName, input, { stillAuthorized: () => false });
    expect(booleanFalse).toMatchObject({ checked: false, decision: "revoked" });

    // A record that is no longer ours reports not-ours without calling the guard.
    const mismatch = await acknowledgeAcceptedInspection(teamName, {
      messageId: "other-message",
      leaderInstanceId: "instance-lead",
      runGeneration: 7,
    });
    expect(mismatch).toMatchObject({ checked: false, decision: "not-ours" });

    expect((await readQuiescenceState(teamName)).inspection?.phase).toBe("accepted");
    const checked = await acknowledgeAcceptedInspection(teamName, input);
    expect(checked).toMatchObject({ checked: true, generation: 1 });
  });
});
