import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeRuntimeStatus,
  readRuntimeStatus,
  replaceRuntimeInstance,
  deleteRuntimeStatus,
  cleanupStaleRuntimeFiles,
  createRuntimeError,
  getProcessStartToken,
  isRuntimeProcessAlive,
  markRuntimeQueuedIfIdle,
  setRuntimeActivity,
  updateRuntimeStatusForInstance,
  STARTUP_STALL_MS,
  RUNTIME_STALE_MS,
} from "./runtime";
import { runtimeStatusPath, teamDir } from "./paths";
import * as paths from "./paths";

const testDir = path.join(os.tmpdir(), `pi-teams-runtime-test-${Date.now()}`);

describe("runtime status", () => {
  const teamName = `runtime-test-${Date.now()}`;
  const agentName = "worker-1";

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "runtimeStatusPath").mockImplementation((_teamName, currentAgentName) => (
      path.join(testDir, "runtime", `${currentAgentName}.json`)
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("writes and reads status", async () => {
    await writeRuntimeStatus(teamName, agentName, {
      pid: 123,
      startedAt: 1000,
      activity: "starting",
    });

    const runtime = await readRuntimeStatus(teamName, agentName);
    expect(runtime).not.toBeNull();
    expect(runtime?.teamName).toBe(teamName);
    expect(runtime?.agentName).toBe(agentName);
    expect(runtime?.pid).toBe(123);
    expect(runtime?.activity).toBe("starting");
  });

  it("merges updates instead of overwriting status", async () => {
    await writeRuntimeStatus(teamName, agentName, {
      pid: 123,
      startedAt: 1000,
      activity: "starting",
    });

    await writeRuntimeStatus(teamName, agentName, {
      lastHeartbeatAt: 2000,
      activity: "running",
    });

    const runtime = await readRuntimeStatus(teamName, agentName);
    expect(runtime?.pid).toBe(123);
    expect(runtime?.startedAt).toBe(1000);
    expect(runtime?.lastHeartbeatAt).toBe(2000);
    expect(runtime?.activity).toBe("running");
  });

  it("returns null when status does not exist", async () => {
    const missing = await readRuntimeStatus(teamName, "missing-agent");
    expect(missing).toBeNull();
  });

  it("stores status in team runtime directory", async () => {
    await writeRuntimeStatus(teamName, agentName, { activity: "running" });
    const p = runtimeStatusPath(teamName, agentName);
    expect(path.basename(path.dirname(p))).toBe("runtime");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("migrates legacy runtime files to activity state", async () => {
    const p = runtimeStatusPath(teamName, agentName);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      teamName,
      agentName,
      startedAt: 1234,
      ready: false,
    }));

    const runtime = await readRuntimeStatus(teamName, agentName);

    expect(runtime?.activity).toBe("starting");
    expect(runtime?.activityChangedAt).toBe(1234);
    expect(JSON.parse(fs.readFileSync(p, "utf-8"))).toMatchObject({
      activity: "starting",
      activityChangedAt: 1234,
    });
    expect(JSON.parse(fs.readFileSync(p, "utf-8"))).not.toHaveProperty("ready");
  });

  it("tracks activity transitions without refreshing an unchanged state", async () => {
    await setRuntimeActivity(teamName, agentName, "running", {
      activityChangedAt: 1000,
    });
    await setRuntimeActivity(teamName, agentName, "running", {
      lastHeartbeatAt: 2000,
    });

    expect(await readRuntimeStatus(teamName, agentName)).toMatchObject({
      activity: "running",
      activityChangedAt: 1000,
      lastHeartbeatAt: 2000,
    });

    await setRuntimeActivity(teamName, agentName, "waiting", {
      activityChangedAt: 3000,
    });
    expect(await readRuntimeStatus(teamName, agentName)).toMatchObject({
      activity: "waiting",
      activityChangedAt: 3000,
    });
  });

  it("atomically queues only idle runtimes", async () => {
    await setRuntimeActivity(teamName, agentName, "idle", {
      activityChangedAt: 1000,
    });

    expect(await markRuntimeQueuedIfIdle(teamName, agentName)).toBe(true);
    expect((await readRuntimeStatus(teamName, agentName))?.activity).toBe("queued");
    expect(await markRuntimeQueuedIfIdle(teamName, agentName)).toBe(false);

    await setRuntimeActivity(teamName, agentName, "running");
    expect(await markRuntimeQueuedIfIdle(teamName, agentName)).toBe(false);
    expect((await readRuntimeStatus(teamName, agentName))?.activity).toBe("running");
  });

  it("updates only the owning runtime instance and expected activity", async () => {
    await setRuntimeActivity(teamName, agentName, "running", {
      instanceId: "current-instance",
    });

    expect(await updateRuntimeStatusForInstance(
      teamName,
      agentName,
      "old-instance",
      { activity: "waiting" },
    )).toBeNull();
    expect(await updateRuntimeStatusForInstance(
      teamName,
      agentName,
      "current-instance",
      { activity: "waiting" },
      "idle",
    )).toBeNull();

    const updated = await updateRuntimeStatusForInstance(
      teamName,
      agentName,
      "current-instance",
      { activity: "waiting" },
      "running",
    );
    expect(updated?.activity).toBe("waiting");
  });

  it("atomically transfers a runtime lease", async () => {
    await setRuntimeActivity(teamName, agentName, "running", {
      instanceId: "old-instance",
    });

    const placeholder = await replaceRuntimeInstance(
      teamName,
      agentName,
      "old-instance",
      "handoff-token",
      { activity: "starting" },
      "running",
    );
    expect(placeholder).toMatchObject({ instanceId: "handoff-token", activity: "starting" });

    const claimed = await replaceRuntimeInstance(
      teamName,
      agentName,
      "handoff-token",
      "new-instance",
      { activity: "idle" },
      "starting",
    );
    expect(claimed).toMatchObject({ instanceId: "new-instance", activity: "idle" });
    expect(await replaceRuntimeInstance(
      teamName,
      agentName,
      "handoff-token",
      "old-instance",
      { activity: "running" },
    )).toBeNull();
  });

  it("checks a live process against its Linux start token", () => {
    const processStartToken = getProcessStartToken(process.pid);
    expect(isRuntimeProcessAlive({ pid: process.pid, processStartToken })).toBe(true);
    if (processStartToken) {
      expect(isRuntimeProcessAlive({ pid: process.pid, processStartToken: `${processStartToken}-old` })).toBe(false);
    }
    expect(isRuntimeProcessAlive({ pid: 999_999_999 })).toBe(false);
  });

  describe("deleteRuntimeStatus", () => {
    it("deletes existing runtime status", async () => {
      await writeRuntimeStatus(teamName, agentName, { activity: "running" });
      const deleted = await deleteRuntimeStatus(teamName, agentName);
      expect(deleted).toBe(true);

      const runtime = await readRuntimeStatus(teamName, agentName);
      expect(runtime).toBeNull();
    });

    it("returns false when status does not exist", async () => {
      const deleted = await deleteRuntimeStatus(teamName, "nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("cleanupStaleRuntimeFiles", () => {
    it("removes stale runtime files with old heartbeats", async () => {
      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      await writeRuntimeStatus(teamName, "stale-agent", {
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        activityChangedAt: staleTime,
        activity: "idle",
      });

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(1);

      const runtime = await readRuntimeStatus(teamName, "stale-agent");
      expect(runtime).toBeNull();
    });

    it("preserves runtime files with recent heartbeats", async () => {
      await writeRuntimeStatus(teamName, agentName, {
        startedAt: Date.now() - RUNTIME_STALE_MS - 1000,
        lastHeartbeatAt: Date.now(),
        activity: "idle",
      });

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(0);

      const runtime = await readRuntimeStatus(teamName, agentName);
      expect(runtime).not.toBeNull();
    });

    it("preserves a live process even when its heartbeat is old", async () => {
      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      await writeRuntimeStatus(teamName, "long-running-agent", {
        pid: process.pid,
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        activityChangedAt: staleTime,
        activity: "running",
      });

      const cleaned = await cleanupStaleRuntimeFiles(teamName);

      expect(cleaned).toBe(0);
      expect(await readRuntimeStatus(teamName, "long-running-agent")).not.toBeNull();
    });

    it("removes a stale runtime when a live PID has a mismatched Linux start token", async () => {
      const processStartToken = getProcessStartToken(process.pid);
      if (process.platform !== "linux" || !processStartToken) return;

      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      await writeRuntimeStatus(teamName, "reused-pid-agent", {
        pid: process.pid,
        processStartToken: `${processStartToken}-old`,
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        activityChangedAt: staleTime,
        activity: "running",
      });

      expect(await cleanupStaleRuntimeFiles(teamName)).toBe(1);
      expect(await readRuntimeStatus(teamName, "reused-pid-agent")).toBeNull();
    });

    it("removes corrupted files", async () => {
      const runtimeDir = path.join(teamDir(teamName), "runtime");
      if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, "corrupted.json"), "not valid json");

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(1);
    });

    it("returns 0 when no runtime directory exists", async () => {
      const cleaned = await cleanupStaleRuntimeFiles("nonexistent-team");
      expect(cleaned).toBe(0);
    });
  });

  describe("createRuntimeError", () => {
    it("creates structured error from Error object", () => {
      const error = new Error("Test error");
      const runtimeError = createRuntimeError(error);
      expect(runtimeError.message).toBe("Test error");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });

    it("creates structured error from string", () => {
      const runtimeError = createRuntimeError("String error");
      expect(runtimeError.message).toBe("String error");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });

    it("creates structured error from unknown type", () => {
      const runtimeError = createRuntimeError({ weird: "object" });
      expect(runtimeError.message).toBe("[object Object]");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });
  });

  describe("constants", () => {
    it("exports STARTUP_STALL_MS with correct value", () => {
      expect(STARTUP_STALL_MS).toBe(60000);
    });

    it("exports RUNTIME_STALE_MS with correct value", () => {
      expect(RUNTIME_STALE_MS).toBe(300000);
    });
  });
});
