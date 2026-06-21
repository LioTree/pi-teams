// Project: pi-teams
import fs from "node:fs";
import path from "node:path";
import { TaskFile } from "./models";
import { taskDir, sanitizeName } from "./paths";
import * as messaging from "./messaging";
import { readConfig, teamExists } from "./teams";
import { withLock } from "./lock";
import { runHook } from "./hooks";

export interface EvaluatePlanOptions {
  evaluatedBy?: string;
  retries?: number;
}

export interface UpdateTaskOptions {
  updatedBy?: string;
  retries?: number;
}

export interface WaitForPlanEvaluationOptions {
  pollIntervalMs?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onPoll?: () => void | Promise<void>;
}

export interface WaitForPlanEvaluationResult {
  task: TaskFile;
  action?: "approve" | "reject";
  waitedMs: number;
  timedOut: boolean;
}

export function getTaskId(teamName: string): string {
  const dir = taskDir(teamName);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const ids = files.map(f => parseInt(path.parse(f).name, 10)).filter(id => !isNaN(id));
  return ids.length > 0 ? (Math.max(...ids) + 1).toString() : "1";
}

function getTaskPath(teamName: string, taskId: string): string {
  const dir = taskDir(teamName);
  const safeTaskId = sanitizeName(taskId);
  return path.join(dir, `${safeTaskId}.json`);
}

async function getLeadName(teamName: string): Promise<string | undefined> {
  const config = await readConfig(teamName);
  return config.members.find(m => m.agentType === "lead")?.name
    ?? config.members.find(m => m.name === "team-lead")?.name;
}

export async function createTask(
  teamName: string,
  subject: string,
  description: string,
  activeForm = "",
  metadata?: Record<string, any>
): Promise<TaskFile> {
  if (!subject || !subject.trim()) throw new Error("Task subject must not be empty");
  if (!teamExists(teamName)) throw new Error(`Team ${teamName} does not exist`);

  const dir = taskDir(teamName);
  const lockPath = dir;

  return await withLock(lockPath, async () => {
    const id = getTaskId(teamName);
    const task: TaskFile = {
      id,
      subject,
      description,
      activeForm,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata,
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task, null, 2));
    return task;
  });
}

export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<TaskFile>,
  optionsOrRetries?: UpdateTaskOptions | number
): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);
  const options = typeof optionsOrRetries === "number"
    ? { retries: optionsOrRetries }
    : optionsOrRetries ?? {};

  const { original, updated } = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
    const updated = { ...task, ...updates };

    if (updates.status === "deleted") {
      fs.unlinkSync(p);
      return { original: task, updated };
    }

    fs.writeFileSync(p, JSON.stringify(updated, null, 2));

    if (updates.status === "completed") {
      await runHook(teamName, "task_completed", updated);
    }

    return { original: task, updated };
  }, options.retries);

  await sendTaskUpdateNotifications(teamName, taskId, original, updated, updates, options.updatedBy);
  return updated;
}

async function sendTaskUpdateNotifications(
  teamName: string,
  taskId: string,
  original: TaskFile,
  updated: TaskFile,
  updates: Partial<TaskFile>,
  updatedBy?: string
) {
  const ownerChanged = updates.owner !== undefined && updates.owner !== original.owner;
  if (ownerChanged && updated.owner && updated.owner !== updatedBy) {
    await messaging.sendPlainMessage(
      teamName,
      updatedBy ?? "team-lead",
      updated.owner,
      `${updatedBy ?? "team-lead"} assigned you task ${taskId} (${updated.subject}). Current status: ${updated.status}.`,
      `Task ${taskId} assigned to you`
    );
  }

  const completedNow = updates.status === "completed" && original.status !== "completed";
  if (completedNow) {
    const leadName = await getLeadName(teamName);
    if (leadName && updatedBy !== leadName) {
      await messaging.sendPlainMessage(
        teamName,
        updatedBy ?? updated.owner ?? "system",
        leadName,
        `Task ${taskId} (${updated.subject}) was marked completed${updated.owner ? ` by ${updated.owner}` : ""}.`,
        `Task ${taskId} completed`
      );
    }
  }
}

/**
 * Submits a plan for a task, updating its status to "planning".
 * @param teamName The name of the team
 * @param taskId The ID of the task
 * @param plan The content of the plan
 * @param submittedBy Optional agent name used to notify the lead
 * @returns The updated task
 */
export async function submitPlan(
  teamName: string,
  taskId: string,
  plan: string,
  submittedBy?: string
): Promise<TaskFile> {
  if (!plan || !plan.trim()) throw new Error("Plan must not be empty");

  let leadName: string | undefined;
  if (submittedBy) {
    leadName = await getLeadName(teamName);

    if (!leadName) {
      throw new Error(`Team ${teamName} has no lead member to notify`);
    }
  }

  const updated = await updateTask(teamName, taskId, { status: "planning", plan, planFeedback: "" });

  if (submittedBy && leadName && submittedBy !== leadName) {
    await messaging.sendPlainMessage(
      teamName,
      submittedBy,
      leadName,
      `${submittedBy} submitted a plan for task ${taskId} (${updated.subject}). Review the task details to approve or reject it.`,
      `Plan submitted for task ${taskId}`
    );
  }

  return updated;
}

/**
 * Evaluates a submitted plan for a task.
 * @param teamName The name of the team
 * @param taskId The ID of the task
 * @param action The evaluation action: "approve" or "reject"
 * @param feedback Optional feedback for the evaluation (required for rejection)
 * @param retries Number of times to retry acquiring the lock
 * @returns The updated task
 */
export async function evaluatePlan(
  teamName: string,
  taskId: string,
  action: "approve" | "reject",
  feedback?: string,
  optionsOrRetries?: EvaluatePlanOptions | number
): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);
  const options = typeof optionsOrRetries === "number"
    ? { retries: optionsOrRetries }
    : optionsOrRetries ?? {};

  const updated = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));

    // 1. Validate state: Only "planning" tasks can be evaluated
    if (task.status !== "planning") {
      throw new Error(
        `Cannot evaluate plan for task ${taskId} because its status is '${task.status}'. ` +
        `Tasks must be in 'planning' status to be evaluated.`
      );
    }

    // 2. Validate plan presence
    if (!task.plan || !task.plan.trim()) {
      throw new Error(`Cannot evaluate plan for task ${taskId} because no plan has been submitted.`);
    }

    // 3. Require feedback for rejections
    if (action === "reject" && (!feedback || !feedback.trim())) {
      throw new Error("Feedback is required when rejecting a plan.");
    }

    // 4. Perform update
    const updates: Partial<TaskFile> = action === "approve" 
      ? { status: "in_progress", planFeedback: "" }
      : { status: "planning", planFeedback: feedback };

    const updated = { ...task, ...updates };
    fs.writeFileSync(p, JSON.stringify(updated, null, 2));
    return updated;
  }, options.retries);

  if (options.evaluatedBy && updated.owner && updated.owner !== options.evaluatedBy) {
    const approved = action === "approve";
    await messaging.sendPlainMessage(
      teamName,
      options.evaluatedBy,
      updated.owner,
      approved
        ? `${options.evaluatedBy} approved your plan for task ${taskId} (${updated.subject}). You may begin implementation.`
        : `${options.evaluatedBy} rejected your plan for task ${taskId} (${updated.subject}). Feedback: ${feedback}`,
      `Plan ${approved ? "approved" : "rejected"} for task ${taskId}`
    );
  }

  return updated;
}

function createAbortError(): Error {
  const error = new Error("wait_for_plan_evaluation aborted");
  error.name = "AbortError";
  return error;
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getPlanEvaluationAction(task: TaskFile): "approve" | "reject" | undefined {
  if (task.status === "in_progress" || task.status === "completed") return "approve";
  if (task.status === "planning" && task.planFeedback?.trim()) return "reject";
  return undefined;
}

export async function waitForPlanEvaluation(
  teamName: string,
  taskId: string,
  options: WaitForPlanEvaluationOptions = {}
): Promise<WaitForPlanEvaluationResult> {
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
  const timeoutMs = options.timeoutSeconds === undefined
    ? undefined
    : Math.max(0, options.timeoutSeconds * 1000);
  const startedAt = Date.now();

  if (options.signal?.aborted) throw createAbortError();

  while (true) {
    if (options.signal?.aborted) throw createAbortError();

    const task = await readTask(teamName, taskId);
    const action = getPlanEvaluationAction(task);
    const waitedMs = Date.now() - startedAt;
    if (action) {
      return { task, action, waitedMs, timedOut: false };
    }

    if (timeoutMs !== undefined && waitedMs >= timeoutMs) {
      return { task, waitedMs, timedOut: true };
    }

    await options.onPoll?.();

    const remainingTimeoutMs = timeoutMs === undefined ? pollIntervalMs : timeoutMs - waitedMs;
    await waitForDelay(Math.min(pollIntervalMs, Math.max(1, remainingTimeoutMs)), options.signal);
  }
}

export async function readTask(teamName: string, taskId: string, retries?: number): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);
  if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
  return await withLock(p, async () => {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }, retries);
}

export async function listTasks(teamName: string): Promise<TaskFile[]> {
  const dir = taskDir(teamName);
  return await withLock(dir, async () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    const tasks: TaskFile[] = files
      .map(f => {
        const id = parseInt(path.parse(f).name, 10);
        if (isNaN(id)) return null;
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      })
      .filter(t => t !== null);
    return tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  });
}

export async function resetOwnerTasks(teamName: string, agentName: string) {
  const dir = taskDir(teamName);
  const lockPath = dir;

  await withLock(lockPath, async () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const p = path.join(dir, f);
      const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (task.owner === agentName) {
        task.owner = undefined;
        if (task.status !== "completed") {
          task.status = "pending";
        }
        fs.writeFileSync(p, JSON.stringify(task, null, 2));
      }
    }
  });
}
