// Project: pi-teams
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskFile } from "./models";
import { taskDir, sanitizeName } from "./paths";
import * as messaging from "./messaging";
import { readConfig, teamExists } from "./teams";
import { withLock } from "./lock";
import { runHook } from "./hooks";
import { atomicWriteJsonSync } from "./atomic-file";

export interface UpdateTaskOptions {
  updatedBy?: string;
  notifyOwner?: boolean;
  retries?: number;
}

export interface CreateTaskOptions {
  activeForm?: string;
  metadata?: Record<string, any>;
}

export interface AssignTaskOptions {
  assignedBy?: string;
  notifyOwner?: boolean;
  status?: TaskFile["status"];
  retries?: number;
}

export interface ClaimTaskOptions {
  claimedBy: string;
  retries?: number;
}

export interface CompleteTaskOptions {
  completedBy: string;
  summary?: string;
  instanceId?: string;
  retries?: number;
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

function readTaskFile(p: string): TaskFile {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as TaskFile;
}

async function getLeadName(teamName: string): Promise<string | undefined> {
  const config = await readConfig(teamName);
  return config.members.find(m => m.agentType === "lead")?.name
    ?? config.members.find(m => m.name === "team-lead")?.name;
}

async function getMember(teamName: string, agentName: string) {
  const config = await readConfig(teamName);
  return config.members.find(m => m.name === agentName);
}

async function assertTeamMember(teamName: string, agentName: string) {
  const member = await getMember(teamName, agentName);
  if (!member) {
    throw new Error(`Agent ${agentName} is not a member of team ${teamName}`);
  }
  return member;
}

async function isLead(teamName: string, agentName?: string): Promise<boolean> {
  if (!agentName) return false;
  return (await getLeadName(teamName)) === agentName;
}

export async function createTask(
  teamName: string,
  subject: string,
  description: string,
  activeFormOrOptions: string | CreateTaskOptions = "",
  metadata?: Record<string, any>
): Promise<TaskFile> {
  if (!subject || !subject.trim()) throw new Error("Task subject must not be empty");
  if (!teamExists(teamName)) throw new Error(`Team ${teamName} does not exist`);

  const options: CreateTaskOptions = typeof activeFormOrOptions === "string"
    ? { activeForm: activeFormOrOptions, metadata }
    : activeFormOrOptions;

  const dir = taskDir(teamName);
  const lockPath = dir;

  return await withLock(lockPath, async () => {
    const id = getTaskId(teamName);
    const task: TaskFile = {
      id,
      subject,
      description,
      activeForm: options.activeForm ?? "",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: options.metadata,
    };
    atomicWriteJsonSync(path.join(dir, `${id}.json`), task);
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

  if (updates.status === "completed") {
    const current = await readTask(teamName, taskId, options.retries);
    if (updates.owner && updates.owner !== current.owner) {
      throw new Error(`Cannot combine owner reassignment with completing task ${taskId}. Assign the task first, then complete it.`);
    }

    return completeTask(teamName, taskId, {
      completedBy: options.updatedBy ?? current.owner ?? "team-lead",
      retries: options.retries,
    });
  }

  const { original, updated } = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task = readTaskFile(p);
    const updated = { ...task, ...updates };

    if (updates.status === "deleted") {
      fs.unlinkSync(p);
      return { original: task, updated };
    }

    atomicWriteJsonSync(p, updated);

    return { original: task, updated };
  }, options.retries);

  await sendTaskUpdateNotifications(teamName, taskId, original, updated, updates, options.updatedBy, options.notifyOwner ?? true);
  return updated;
}

export async function assignTask(
  teamName: string,
  taskId: string,
  owner: string,
  options: AssignTaskOptions = {}
): Promise<TaskFile> {
  await assertTeamMember(teamName, owner);

  const updates: Partial<TaskFile> = { owner };
  if (options.status) updates.status = options.status;

  return updateTask(teamName, taskId, updates, {
    updatedBy: options.assignedBy,
    notifyOwner: options.notifyOwner,
    retries: options.retries,
  });
}

export async function claimTask(
  teamName: string,
  taskId: string,
  options: ClaimTaskOptions
): Promise<TaskFile> {
  await assertTeamMember(teamName, options.claimedBy);
  const p = getTaskPath(teamName, taskId);

  const { original, updated } = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task = readTaskFile(p);

    if (task.status !== "pending") {
      throw new Error(`Cannot claim task ${taskId} because its status is '${task.status}'.`);
    }

    if (task.owner && task.owner !== options.claimedBy) {
      throw new Error(`Cannot claim task ${taskId} because it is already assigned to ${task.owner}.`);
    }

    const updated: TaskFile = {
      ...task,
      owner: options.claimedBy,
      status: "in_progress",
    };
    atomicWriteJsonSync(p, updated);
    return { original: task, updated };
  }, options.retries);

  await sendTaskUpdateNotifications(teamName, taskId, original, updated, {
    owner: options.claimedBy,
    status: updated.status,
  }, options.claimedBy);
  return updated;
}

export async function completeTask(
  teamName: string,
  taskId: string,
  options: CompleteTaskOptions
): Promise<TaskFile> {
  await assertTeamMember(teamName, options.completedBy);
  const leadName = await getLeadName(teamName);
  const p = getTaskPath(teamName, taskId);

  const { original, candidate } = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task = readTaskFile(p);

    if (task.status === "deleted") {
      throw new Error(`Cannot complete task ${taskId} because it is deleted.`);
    }
    if (task.status === "completed") {
      throw new Error(`Cannot complete task ${taskId} because it is already completed.`);
    }
    if (task.status !== "in_progress") {
      throw new Error(`Cannot complete task ${taskId} because its status is '${task.status}'.`);
    }
    if (task.owner && task.owner !== options.completedBy && !(await isLead(teamName, options.completedBy))) {
      throw new Error(`Cannot complete task ${taskId} because it is assigned to ${task.owner}.`);
    }

    const updated: TaskFile = {
      ...task,
      owner: task.owner ?? options.completedBy,
      status: "completed",
      metadata: options.summary
        ? { ...(task.metadata ?? {}), completionSummary: options.summary }
        : task.metadata,
      completionNotice: leadName && options.completedBy !== leadName ? {
        id: randomUUID(),
        from: options.completedBy,
        timestamp: messaging.nowIso(),
        read: false,
        text: `Task ${taskId} (${task.subject}) was marked completed by ${task.owner ?? options.completedBy}.${options.summary ? `\nCompletion summary: ${options.summary}` : ""}`,
        summary: `Task ${taskId} completed`,
      } : undefined,
    };

    return { original: task, candidate: updated };
  }, options.retries);

  const hookOk = await runHook(teamName, "task_completed", candidate);
  if (!hookOk) {
    throw new Error(`task_completed hook failed; task ${taskId} was not completed.`);
  }

  const updated = await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const current = readTaskFile(p);
    if (JSON.stringify(current) !== JSON.stringify(original)) {
      throw new Error(`Task ${taskId} changed while completion hook was running; completion was not applied.`);
    }

    atomicWriteJsonSync(p, candidate);
    return candidate;
  }, options.retries);

  await sendTaskUpdateNotifications(teamName, taskId, original, updated, {
    status: "completed",
  }, options.completedBy, true, { instanceId: options.instanceId });
  return updated;
}

async function sendTaskUpdateNotifications(
  teamName: string,
  taskId: string,
  original: TaskFile,
  updated: TaskFile,
  updates: Partial<TaskFile>,
  updatedBy?: string,
  notifyOwner = true,
  reportOptions: messaging.ReportOptions = {},
) {
  const ownerChanged = updates.owner !== undefined && updates.owner !== original.owner;
  if (notifyOwner && ownerChanged && updated.owner && updated.owner !== updatedBy) {
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
        updated.completionNotice?.text ?? `Task ${taskId} (${updated.subject}) was marked completed${updated.owner ? ` by ${updated.owner}` : ""}.`,
        `Task ${taskId} completed`,
        undefined,
        { ...reportOptions, messageId: updated.completionNotice?.id },
      );
    }
  }
}

export async function readTask(teamName: string, taskId: string, retries?: number): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);
  if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
  return await withLock(p, async () => {
    return readTaskFile(p);
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
        return readTaskFile(path.join(dir, f));
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
      const task = readTaskFile(p);
      if (task.owner === agentName) {
        task.owner = undefined;
        if (task.status !== "completed") {
          task.status = "pending";
        }
        atomicWriteJsonSync(p, task);
      }
    }
  });
}
