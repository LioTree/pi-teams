// Project: pi-teams
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assignTask,
  claimTask,
  completeTask,
  createTask,
  listTasks,
  readTask,
  resetOwnerTasks,
  updateTask,
} from "./tasks";
import * as messaging from "./messaging";
import * as paths from "./paths";

const testDir = path.join(os.tmpdir(), `pi-teams-tasks-test-${process.pid}`);

describe("Tasks Utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(path.join(testDir, "project"));
    vi.spyOn(paths, "taskDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(testDir, "config.json"));
    vi.spyOn(paths, "inboxPath").mockImplementation((_teamName, agentName) =>
      path.join(testDir, "inboxes", `${agentName}.json`));

    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "team-lead", agentType: "lead" },
        { name: "teammate", agentType: "teammate" },
        { name: "other", agentType: "teammate" },
      ],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("creates tasks with the current schema", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description", {
      activeForm: "Testing",
      metadata: { source: "delegate_task" },
    });

    expect(task).toMatchObject({
      id: "1",
      subject: "Test Subject",
      status: "pending",
      activeForm: "Testing",
      metadata: { source: "delegate_task" },
    });
    const stored = JSON.parse(fs.readFileSync(path.join(testDir, "1.json"), "utf-8"));
    expect(stored).not.toHaveProperty("planRequired");
    expect(stored).not.toHaveProperty("plan");
    expect(stored).not.toHaveProperty("planFeedback");
  });

  it("updates and assigns a task", async () => {
    const task = await createTask("test-team", "Assign Test", "Should assign owner");
    const assigned = await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });

    expect(assigned.owner).toBe("teammate");
    expect(assigned.status).toBe("in_progress");
  });

  it("notifies the owner when assigned", async () => {
    const notifySpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue({
      id: "assignment-message",
      from: "team-lead",
      text: "assigned",
      timestamp: new Date(0).toISOString(),
      read: false,
    });
    const task = await createTask("test-team", "Assignment Test", "Should notify owner");

    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });

    expect(notifySpy).toHaveBeenCalledWith(
      "test-team",
      "team-lead",
      "teammate",
      expect.stringContaining(`assigned you task ${task.id}`),
      `Task ${task.id} assigned to you`,
    );
  });

  it("can suppress assignment notifications", async () => {
    const notifySpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue({
      id: "suppressed-message",
      from: "team-lead",
      text: "assigned",
      timestamp: new Date(0).toISOString(),
      read: false,
    });
    const task = await createTask("test-team", "Assignment Test", "No notification");

    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("rejects assignment to a non-member", async () => {
    const task = await createTask("test-team", "Assign Test", "Should reject unknown owner");
    await expect(assignTask("test-team", task.id, "stranger"))
      .rejects.toThrow("is not a member");
  });

  it("lets a teammate claim an unassigned task and starts it immediately", async () => {
    const task = await createTask("test-team", "Claim Test", "Should be claimable");
    const claimed = await claimTask("test-team", task.id, { claimedBy: "teammate" });

    expect(claimed.owner).toBe("teammate");
    expect(claimed.status).toBe("in_progress");
  });

  it("rejects a claim owned by someone else", async () => {
    const task = await createTask("test-team", "Claim Test", "Should reject claim");
    await assignTask("test-team", task.id, "teammate", { assignedBy: "team-lead" });

    await expect(claimTask("test-team", task.id, { claimedBy: "other" }))
      .rejects.toThrow("already assigned to teammate");
  });

  it("rejects a claim when the task has already started", async () => {
    const task = await createTask("test-team", "Claim Test", "Already started");
    await updateTask("test-team", task.id, { status: "in_progress" });

    await expect(claimTask("test-team", task.id, { claimedBy: "teammate" }))
      .rejects.toThrow("status is 'in_progress'");
  });

  it("completes a task and stores its summary", async () => {
    const notifySpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue({
      id: "completion-message",
      from: "teammate",
      text: "completed",
      timestamp: new Date(0).toISOString(),
      read: false,
    });
    const task = await createTask("test-team", "Completion Test", "Should complete");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });

    const completed = await completeTask("test-team", task.id, {
      completedBy: "teammate",
      summary: "Done with tests",
    });

    expect(completed.status).toBe("completed");
    expect(completed.metadata?.completionSummary).toBe("Done with tests");
    expect(notifySpy).toHaveBeenCalledWith(
      "test-team",
      "teammate",
      "team-lead",
      expect.stringContaining(`Task ${task.id}`),
      `Task ${task.id} completed`,
    );
  });

  it("does not let a non-owner complete another teammate's task", async () => {
    const task = await createTask("test-team", "Completion Test", "Wrong owner");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });

    await expect(completeTask("test-team", task.id, { completedBy: "other" }))
      .rejects.toThrow("assigned to teammate");
  });

  it("requires in_progress status for completion", async () => {
    const task = await createTask("test-team", "Completion Test", "Still pending");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      notifyOwner: false,
    });

    await expect(completeTask("test-team", task.id, { completedBy: "teammate" }))
      .rejects.toThrow("status is 'pending'");
  });

  it("does not combine owner reassignment with completion", async () => {
    const task = await createTask("test-team", "Completion Test", "Atomic ownership");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });

    await expect(updateTask("test-team", task.id, {
      owner: "other",
      status: "completed",
    }, { updatedBy: "team-lead" })).rejects.toThrow("Cannot combine owner reassignment");
  });

  it("does not complete a task twice", async () => {
    const task = await createTask("test-team", "Completion Test", "Only once");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });
    await completeTask("test-team", task.id, { completedBy: "teammate" });

    await expect(completeTask("test-team", task.id, { completedBy: "teammate" }))
      .rejects.toThrow("already completed");
  });

  it("keeps the task in progress when the completion hook fails", async () => {
    const hooksDir = path.join(process.cwd(), ".pi", "team-hooks");
    const hookPath = path.join(hooksDir, "task_completed.sh");
    const originalHook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf-8") : undefined;
    const originalMode = fs.existsSync(hookPath) ? fs.statSync(hookPath).mode : undefined;
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, "#!/bin/bash\nexit 1", { mode: 0o755 });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const task = await createTask("test-team", "Completion Test", "Hook failure");
      await assignTask("test-team", task.id, "teammate", {
        assignedBy: "team-lead",
        status: "in_progress",
        notifyOwner: false,
      });

      await expect(completeTask("test-team", task.id, { completedBy: "teammate" }))
        .rejects.toThrow("hook failed");
      expect((await readTask("test-team", task.id)).status).toBe("in_progress");
    } finally {
      consoleSpy.mockRestore();
      if (originalHook !== undefined) {
        fs.writeFileSync(hookPath, originalHook, { mode: originalMode });
      } else if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
      }
    }
  });

  it("reads an owned legacy planning task without modifying it", async () => {
    const legacyPath = path.join(testDir, "1.json");
    const legacyTask = {
      id: "1",
      subject: "Legacy",
      description: "Old schema",
      status: "planning",
      owner: "teammate",
      planRequired: true,
      plan: "old plan",
      planFeedback: "old feedback",
      blocks: [],
      blockedBy: [],
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacyTask));
    const before = fs.readFileSync(legacyPath, "utf-8");

    const task = await readTask("test-team", "1");

    expect(task).toMatchObject(legacyTask);
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(before);
  });

  it("lists an unowned legacy planning task without modifying it", async () => {
    const legacyPath = path.join(testDir, "1.json");
    const legacyTask = {
      id: "1",
      subject: "Legacy",
      description: "Old schema",
      status: "planning",
      plan: "old plan",
      blocks: [],
      blockedBy: [],
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacyTask));
    const before = fs.readFileSync(legacyPath, "utf-8");

    const listed = await listTasks("test-team");

    expect(listed[0]).toMatchObject(legacyTask);
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(before);
  });

  it("lists tasks in numeric order", async () => {
    await createTask("test-team", "Task 1", "Desc 1");
    await createTask("test-team", "Task 2", "Desc 2");
    expect((await listTasks("test-team")).map(task => task.id)).toEqual(["1", "2"]);
  });

  it("resets unfinished tasks owned by a removed teammate", async () => {
    const task = await createTask("test-team", "Reset", "Reset owner");
    await assignTask("test-team", task.id, "teammate", {
      status: "in_progress",
      notifyOwner: false,
    });

    await resetOwnerTasks("test-team", "teammate");
    expect(await readTask("test-team", task.id)).toMatchObject({ status: "pending" });
    expect((await readTask("test-team", task.id)).owner).toBeUndefined();
  });

  it("uses the same lock path for reads and updates", async () => {
    await createTask("test-team", "Lock Test", "Consistent locking");
    const taskFile = path.join(testDir, "1.json");
    fs.writeFileSync(`${taskFile}.lock`, "9999");

    await expect(updateTask("test-team", "1", { status: "in_progress" }, 2))
      .rejects.toThrow("Could not acquire lock");
    await expect(readTask("test-team", "1", 2)).rejects.toThrow("Could not acquire lock");
    fs.unlinkSync(`${taskFile}.lock`);
  });

  it("sanitizes task IDs in file operations", async () => {
    await expect(readTask("test-team", "../evil-id"))
      .rejects.toThrow(/Invalid name: "\.\.\/evil-id"/);
    await expect(updateTask("test-team", "../evil-id", { status: "in_progress" }))
      .rejects.toThrow(/Invalid name: "\.\.\/evil-id"/);
  });
});
