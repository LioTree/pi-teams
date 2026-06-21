// Project: pi-teams
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTask, updateTask, readTask, listTasks, submitPlan, submitPlanAndWaitForEvaluation, evaluatePlan, waitForPlanEvaluation } from "./tasks";
import * as messaging from "./messaging";
import * as paths from "./paths";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-test-" + Date.now());

describe("Tasks Utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    
    // Override paths to use testDir
    vi.spyOn(paths, "taskDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(testDir, "config.json"));
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "inboxes", `${agentName}.json`);
    });
    
    // Create a dummy team config
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "team-lead", agentType: "lead" },
        { name: "teammate", agentType: "teammate" },
      ],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should create a task successfully", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    expect(task.id).toBe("1");
    expect(task.subject).toBe("Test Subject");
    expect(fs.existsSync(path.join(testDir, "1.json"))).toBe(true);
  });

  it("should update a task successfully", async () => {
    await createTask("test-team", "Test Subject", "Test Description");
    const updated = await updateTask("test-team", "1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    
    const taskData = JSON.parse(fs.readFileSync(path.join(testDir, "1.json"), "utf-8"));
    expect(taskData.status).toBe("in_progress");
  });

  it("should wake the task owner when a task is assigned", async () => {
    const task = await createTask("test-team", "Assignment Test", "Should wake owner");
    const waiting = messaging.waitForInbox("test-team", "teammate", { pollIntervalMs: 5 });

    setTimeout(() => {
      void updateTask("test-team", task.id, {
        owner: "teammate",
        status: "in_progress",
      }, {
        updatedBy: "team-lead",
      });
    }, 20);

    const result = await waiting;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("team-lead");
    expect(result.messages[0].summary).toBe(`Task ${task.id} assigned to you`);
  });

  it("should wake the lead when a task is completed", async () => {
    const task = await createTask("test-team", "Completion Test", "Should wake lead");
    await updateTask("test-team", task.id, {
      owner: "teammate",
      status: "in_progress",
    }, {
      updatedBy: "team-lead",
    });
    await messaging.readInbox("test-team", "teammate", true, true);
    const waiting = messaging.waitForInbox("test-team", "team-lead", { pollIntervalMs: 5 });

    setTimeout(() => {
      void updateTask("test-team", task.id, { status: "completed" }, { updatedBy: "teammate" });
    }, 20);

    const result = await waiting;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("teammate");
    expect(result.messages[0].summary).toBe(`Task ${task.id} completed`);
  });

  it("should submit a plan successfully", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    const plan = "Step 1: Do something\nStep 2: Profit";
    const updated = await submitPlan("test-team", task.id, plan);
    expect(updated.status).toBe("planning");
    expect(updated.plan).toBe(plan);
    
    const taskData = JSON.parse(fs.readFileSync(path.join(testDir, `${task.id}.json`), "utf-8"));
    expect(taskData.status).toBe("planning");
    expect(taskData.plan).toBe(plan);
  });

  it("should fail to submit an empty plan", async () => {
    const task = await createTask("test-team", "Empty Test", "Should fail");
    await expect(submitPlan("test-team", task.id, "")).rejects.toThrow("Plan must not be empty");
    await expect(submitPlan("test-team", task.id, "   ")).rejects.toThrow("Plan must not be empty");
  });

  it("should notify the lead when a teammate submits a plan", async () => {
    const notifySpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined);
    const task = await createTask("test-team", "Test Subject", "Test Description");

    await submitPlan("test-team", task.id, "Step 1: Do something", "teammate");

    expect(notifySpy).toHaveBeenCalledWith(
      "test-team",
      "teammate",
      "team-lead",
      expect.stringContaining(`task ${task.id} (Test Subject)`),
      `Plan submitted for task ${task.id}`
    );
  });

  it("should wake the lead when a teammate submits a plan", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    const waiting = messaging.waitForInbox("test-team", "team-lead", { pollIntervalMs: 5 });

    setTimeout(() => {
      void submitPlan("test-team", task.id, "Step 1: Do something", "teammate");
    }, 20);

    const result = await waiting;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("teammate");
    expect(result.messages[0].summary).toBe(`Plan submitted for task ${task.id}`);
  });

  it("should list tasks", async () => {
    await createTask("test-team", "Task 1", "Desc 1");
    await createTask("test-team", "Task 2", "Desc 2");
    const tasksList = await listTasks("test-team");
    expect(tasksList.length).toBe(2);
    expect(tasksList[0].id).toBe("1");
    expect(tasksList[1].id).toBe("2");
  });

  it("should have consistent lock paths (Fixed BUG 2)", async () => {
    // This test verifies that both updateTask and readTask now use the same lock path
    // Both should now lock `${taskId}.json.lock`
    
    await createTask("test-team", "Bug Test", "Testing lock consistency");
    const taskId = "1";
    
    const taskFile = path.join(testDir, `${taskId}.json`);
    const commonLockFile = `${taskFile}.lock`;
    
    // 1. Holding the common lock
    fs.writeFileSync(commonLockFile, "9999");
    
    // 2. Try updateTask, it should fail
    // Using small retries to speed up the test and avoid fake timer issues with native setTimeout
    await expect(updateTask("test-team", taskId, { status: "in_progress" }, 2)).rejects.toThrow("Could not acquire lock");

    // 3. Try readTask, it should fail too
    await expect(readTask("test-team", taskId, 2)).rejects.toThrow("Could not acquire lock");
    
    fs.unlinkSync(commonLockFile);
  });

  it("should approve a plan successfully", async () => {
    const task = await createTask("test-team", "Plan Test", "Should be approved");
    await submitPlan("test-team", task.id, "Wait for it...");
    
    const approved = await evaluatePlan("test-team", task.id, "approve");
    expect(approved.status).toBe("in_progress");
    expect(approved.planFeedback).toBe("");
  });

  it("should notify the task owner when a plan is approved", async () => {
    const notifySpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined);
    const task = await createTask("test-team", "Plan Test", "Should notify owner");
    await updateTask("test-team", task.id, { owner: "teammate" });
    await submitPlan("test-team", task.id, "Wait for it...");

    await evaluatePlan("test-team", task.id, "approve", undefined, { evaluatedBy: "team-lead" });

    expect(notifySpy).toHaveBeenCalledWith(
      "test-team",
      "team-lead",
      "teammate",
      expect.stringContaining(`approved your plan for task ${task.id}`),
      `Plan approved for task ${task.id}`
    );
  });

  it("should wake the task owner when a plan is approved", async () => {
    const task = await createTask("test-team", "Plan Test", "Should wake owner");
    await updateTask("test-team", task.id, { owner: "teammate" });
    await submitPlan("test-team", task.id, "Wait for it...");
    await messaging.readInbox("test-team", "teammate", true, true);
    const waiting = messaging.waitForInbox("test-team", "teammate", { pollIntervalMs: 5 });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "approve", undefined, { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("team-lead");
    expect(result.messages[0].summary).toBe(`Plan approved for task ${task.id}`);
  });

  it("should wait for plan approval", async () => {
    const task = await createTask("test-team", "Plan Test", "Should wait for approval");
    await updateTask("test-team", task.id, { owner: "teammate" });
    await submitPlan("test-team", task.id, "Wait for it...");
    const waiting = waitForPlanEvaluation("test-team", task.id, { pollIntervalMs: 5 });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "approve", undefined, { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.action).toBe("approve");
    expect(result.task.status).toBe("in_progress");
  });

  it("should submit a plan and wait for approval", async () => {
    const task = await createTask("test-team", "Plan Test", "Should submit and wait");
    await updateTask("test-team", task.id, { owner: "teammate" });
    const waiting = submitPlanAndWaitForEvaluation("test-team", task.id, "Wait for it...", {
      submittedBy: "teammate",
      pollIntervalMs: 5,
    });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "approve", undefined, { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.action).toBe("approve");
    expect(result.task.status).toBe("in_progress");
  });

  it("should reject a plan with feedback", async () => {
    const task = await createTask("test-team", "Plan Test", "Should be rejected");
    await submitPlan("test-team", task.id, "Wait for it...");
    
    const feedback = "Not good enough!";
    const rejected = await evaluatePlan("test-team", task.id, "reject", feedback);
    expect(rejected.status).toBe("planning");
    expect(rejected.planFeedback).toBe(feedback);
  });

  it("should wake the task owner when a plan is rejected", async () => {
    const task = await createTask("test-team", "Plan Test", "Should wake owner on rejection");
    await updateTask("test-team", task.id, { owner: "teammate" });
    await submitPlan("test-team", task.id, "Wait for it...");
    await messaging.readInbox("test-team", "teammate", true, true);
    const waiting = messaging.waitForInbox("test-team", "teammate", { pollIntervalMs: 5 });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "reject", "Add tests", { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("team-lead");
    expect(result.messages[0].summary).toBe(`Plan rejected for task ${task.id}`);
    expect(result.messages[0].text).toContain("Add tests");
  });

  it("should wait for plan rejection", async () => {
    const task = await createTask("test-team", "Plan Test", "Should wait for rejection");
    await updateTask("test-team", task.id, { owner: "teammate" });
    await submitPlan("test-team", task.id, "Wait for it...");
    const waiting = waitForPlanEvaluation("test-team", task.id, { pollIntervalMs: 5 });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "reject", "Add tests", { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.action).toBe("reject");
    expect(result.task.status).toBe("planning");
    expect(result.task.planFeedback).toBe("Add tests");
  });

  it("should submit a plan and wait for rejection", async () => {
    const task = await createTask("test-team", "Plan Test", "Should submit and wait for rejection");
    await updateTask("test-team", task.id, { owner: "teammate" });
    const waiting = submitPlanAndWaitForEvaluation("test-team", task.id, "Wait for it...", {
      submittedBy: "teammate",
      pollIntervalMs: 5,
    });

    setTimeout(() => {
      void evaluatePlan("test-team", task.id, "reject", "Add tests", { evaluatedBy: "team-lead" });
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.action).toBe("reject");
    expect(result.task.status).toBe("planning");
    expect(result.task.planFeedback).toBe("Add tests");
  });

  it("should clear previous feedback when resubmitting a plan", async () => {
    const task = await createTask("test-team", "Plan Test", "Should clear feedback");
    await submitPlan("test-team", task.id, "First plan");
    await evaluatePlan("test-team", task.id, "reject", "Add tests");

    const resubmitted = await submitPlan("test-team", task.id, "Revised plan");

    expect(resubmitted.planFeedback).toBe("");
    expect(resubmitted.plan).toBe("Revised plan");
  });

  it("should not let the lead submit and wait for their own evaluation", async () => {
    const task = await createTask("test-team", "Plan Test", "Lead should not self-wait");

    await expect(submitPlanAndWaitForEvaluation("test-team", task.id, "Wait for it...", {
      submittedBy: "team-lead",
      pollIntervalMs: 5,
    })).rejects.toThrow("must be called by a teammate");

    const unchanged = await readTask("test-team", task.id);
    expect(unchanged.status).toBe("pending");
    expect(unchanged.plan).toBeUndefined();
  });

  it("should time out while waiting for plan evaluation", async () => {
    const task = await createTask("test-team", "Plan Test", "Should time out");
    await submitPlan("test-team", task.id, "Wait for it...");

    const result = await waitForPlanEvaluation("test-team", task.id, {
      pollIntervalMs: 5,
      timeoutSeconds: 0.01,
    });

    expect(result.timedOut).toBe(true);
    expect(result.action).toBeUndefined();
    expect(result.task.status).toBe("planning");
  });

  it("should fail to evaluate a task not in 'planning' status", async () => {
    const task = await createTask("test-team", "Status Test", "Invalid status for eval");
    // status is "pending"
    await expect(evaluatePlan("test-team", task.id, "approve")).rejects.toThrow("must be in 'planning' status");
  });

  it("should fail to evaluate a task without a plan", async () => {
    const task = await createTask("test-team", "Plan Missing Test", "No plan submitted");
    await updateTask("test-team", task.id, { status: "planning" }); // bypass submitPlan to have no plan
    await expect(evaluatePlan("test-team", task.id, "approve")).rejects.toThrow("no plan has been submitted");
  });

  it("should fail to reject a plan without feedback", async () => {
    const task = await createTask("test-team", "Feedback Test", "Should require feedback");
    await submitPlan("test-team", task.id, "My plan");
    await expect(evaluatePlan("test-team", task.id, "reject")).rejects.toThrow("Feedback is required when rejecting a plan");
    await expect(evaluatePlan("test-team", task.id, "reject", "   ")).rejects.toThrow("Feedback is required when rejecting a plan");
  });

  it("should sanitize task IDs in all file operations", async () => {
    const dirtyId = "../evil-id";
    // sanitizeName should throw on this dirtyId
    await expect(readTask("test-team", dirtyId)).rejects.toThrow(/Invalid name: "..\/evil-id"/);
    await expect(updateTask("test-team", dirtyId, { status: "in_progress" })).rejects.toThrow(/Invalid name: "..\/evil-id"/);
    await expect(evaluatePlan("test-team", dirtyId, "approve")).rejects.toThrow(/Invalid name: "..\/evil-id"/);
  });
});
