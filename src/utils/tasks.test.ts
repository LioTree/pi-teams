// Project: pi-teams
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTask, updateTask, readTask, listTasks, submitPlan, submitPlanAndWaitForEvaluation, evaluatePlan, waitForPlanEvaluation, assignTask, claimTask, completeTask } from "./tasks";
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
        { name: "other", agentType: "teammate" },
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

  it("should create a task with plan approval metadata", async () => {
    const task = await createTask("test-team", "Plan Required", "Needs approval", {
      planRequired: true,
      metadata: { source: "delegate_task" },
    });

    expect(task.planRequired).toBe(true);
    expect(task.metadata).toEqual({ source: "delegate_task" });
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

  it("should assign a task to a team member", async () => {
    const task = await createTask("test-team", "Assign Test", "Should assign owner");

    const assigned = await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      planRequired: true,
    });

    expect(assigned.owner).toBe("teammate");
    expect(assigned.status).toBe("in_progress");
    expect(assigned.planRequired).toBe(true);
  });

  it("should optionally suppress assignment wake-up messages", async () => {
    const task = await createTask("test-team", "Assign Test", "Should suppress wake-up");

    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
      notifyOwner: false,
    });

    const inbox = await messaging.readInbox("test-team", "teammate");
    expect(inbox).toEqual([]);
  });

  it("should reject assignment to a non-member", async () => {
    const task = await createTask("test-team", "Assign Test", "Should reject unknown owner");

    await expect(assignTask("test-team", task.id, "stranger", {
      assignedBy: "team-lead",
    })).rejects.toThrow("is not a member");
  });

  it("should let a teammate claim an unassigned task", async () => {
    const task = await createTask("test-team", "Claim Test", "Should be claimable");

    const claimed = await claimTask("test-team", task.id, { claimedBy: "teammate" });

    expect(claimed.owner).toBe("teammate");
    expect(claimed.status).toBe("in_progress");
  });

  it("should keep a plan-required claimed task pending until plan submission", async () => {
    const task = await createTask("test-team", "Claim Test", "Should stay pending", {
      planRequired: true,
    });

    const claimed = await claimTask("test-team", task.id, { claimedBy: "teammate" });

    expect(claimed.owner).toBe("teammate");
    expect(claimed.status).toBe("pending");
  });

  it("should reject claim for a task assigned to someone else", async () => {
    const task = await createTask("test-team", "Claim Test", "Should reject claim");
    await assignTask("test-team", task.id, "teammate", { assignedBy: "team-lead" });

    await expect(claimTask("test-team", task.id, { claimedBy: "team-lead" }))
      .rejects.toThrow("already assigned to teammate");
  });

  it("should reject claim for a non-pending task", async () => {
    const task = await createTask("test-team", "Claim Test", "Should reject non-pending");
    await updateTask("test-team", task.id, { status: "in_progress" });

    await expect(claimTask("test-team", task.id, { claimedBy: "teammate" }))
      .rejects.toThrow("status is 'in_progress'");
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

  it("should not combine owner reassignment with updateTask completion", async () => {
    const task = await createTask("test-team", "Completion Test", "Should reject combined update");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });

    await expect(updateTask("test-team", task.id, {
      owner: "other",
      status: "completed",
    }, {
      updatedBy: "team-lead",
    })).rejects.toThrow("Cannot combine owner reassignment with completing task");

    const unchanged = await readTask("test-team", task.id);
    expect(unchanged.owner).toBe("teammate");
    expect(unchanged.status).toBe("in_progress");
  });

  it("should complete a task with semantic completion metadata", async () => {
    const task = await createTask("test-team", "Completion Test", "Should complete");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });

    const completed = await completeTask("test-team", task.id, {
      completedBy: "teammate",
      summary: "Done with tests",
    });

    expect(completed.status).toBe("completed");
    expect(completed.metadata?.completionSummary).toBe("Done with tests");
  });

  it("should not let a non-owner complete someone else's task", async () => {
    const task = await createTask("test-team", "Completion Test", "Should reject wrong owner");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });

    await expect(completeTask("test-team", task.id, {
      completedBy: "other",
    })).rejects.toThrow("assigned to teammate");

    const unchanged = await readTask("test-team", task.id);
    expect(unchanged.status).toBe("in_progress");
  });

  it("should not complete a plan-required task before plan approval", async () => {
    const task = await createTask("test-team", "Completion Test", "Requires approval", {
      planRequired: true,
    });
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "pending",
      planRequired: true,
    });

    await expect(completeTask("test-team", task.id, {
      completedBy: "teammate",
    })).rejects.toThrow("before its required plan is approved");

    const unchanged = await readTask("test-team", task.id);
    expect(unchanged.status).toBe("pending");
  });

  it("should not complete a pending task", async () => {
    const task = await createTask("test-team", "Completion Test", "Should require in_progress");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "pending",
    });

    await expect(completeTask("test-team", task.id, {
      completedBy: "teammate",
    })).rejects.toThrow("status is 'pending'");
  });

  it("should not complete an already completed task again", async () => {
    const task = await createTask("test-team", "Completion Test", "Should reject duplicate completion");
    await assignTask("test-team", task.id, "teammate", {
      assignedBy: "team-lead",
      status: "in_progress",
    });
    await completeTask("test-team", task.id, { completedBy: "teammate" });

    await expect(completeTask("test-team", task.id, {
      completedBy: "teammate",
    })).rejects.toThrow("already completed");
  });

  it("should block semantic completion when the completion hook fails", async () => {
    const hooksDir = path.join(process.cwd(), ".pi", "team-hooks");
    const hookPath = path.join(hooksDir, "task_completed.sh");
    const originalHook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf-8") : undefined;
    const originalMode = fs.existsSync(hookPath) ? fs.statSync(hookPath).mode : undefined;
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, "#!/bin/bash\nexit 1", { mode: 0o755 });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const task = await createTask("test-team", "Completion Test", "Should block hook failure");
      await assignTask("test-team", task.id, "teammate", {
        assignedBy: "team-lead",
        status: "in_progress",
      });

      await expect(completeTask("test-team", task.id, {
        completedBy: "teammate",
      })).rejects.toThrow("hook failed");

      const unchanged = await readTask("test-team", task.id);
      expect(unchanged.status).toBe("in_progress");
    } finally {
      consoleSpy.mockRestore();
      if (originalHook !== undefined) {
        fs.writeFileSync(hookPath, originalHook, { mode: originalMode });
      } else if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
      }
    }
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

  it("should assign an unowned task to the teammate that submits a plan", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");

    const updated = await submitPlan("test-team", task.id, "Step 1: Do something", "teammate");

    expect(updated.owner).toBe("teammate");
    expect(updated.status).toBe("planning");
  });

  it("should reject plan submission by a non-owner", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    await assignTask("test-team", task.id, "teammate", { assignedBy: "team-lead" });

    await expect(submitPlan("test-team", task.id, "Step 1: Do something", "other"))
      .rejects.toThrow("assigned to teammate");
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

  it("should reject plan evaluation by a non-lead", async () => {
    const task = await createTask("test-team", "Plan Test", "Should require lead approval");
    await assignTask("test-team", task.id, "teammate", { assignedBy: "team-lead" });
    await submitPlan("test-team", task.id, "Wait for it...", "teammate");

    await expect(evaluatePlan("test-team", task.id, "approve", undefined, { evaluatedBy: "other" }))
      .rejects.toThrow("Only the team lead");
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
