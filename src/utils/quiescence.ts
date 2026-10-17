import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "./atomic-file";
import { withLock } from "./lock";
import type { Member } from "./models";
import { appendMessageOnce, readInbox, readInboxMessage, rewriteUnreadMessage } from "./messaging";
import { teamDir } from "./paths";
import {
  isRuntimeProcessAlive,
  markRuntimeQueuedIfIdle,
  readRuntimeStatus,
  type AgentActivity,
  type AgentRuntimeStatus,
} from "./runtime";
import { listTasks } from "./tasks";
import { readConfig } from "./teams";

/** Marker for the one team-wide inspection notice. Not a completion report. */
export const QUIESCENCE_MARKER = "[pi-teams quiescence inspection]";

export interface QuiescenceLiveness {
  isMemberAlive(
    teamName: string,
    member: Member,
    status: AgentRuntimeStatus | null,
  ): boolean;
}

export interface QuiescenceMemberView {
  name: string;
  agentType: string;
  alive: boolean;
  activity: AgentActivity | "unknown";
  unreadCount: number;
  unreadIds: string[];
  awaitingConfirmation: boolean;
  instanceId?: string;
}

export interface QuiescenceTaskView {
  id: string;
  subject: string;
  status: string;
  owner?: string;
}

export interface QuiescenceSnapshot {
  leadName: string;
  members: QuiescenceMemberView[];
  tasks: QuiescenceTaskView[];
}

export interface QuiescenceInspection {
  generation: number;
  messageId: string;
  phase: "reserved" | "pending" | "accepted";
  leaderInstanceId?: string;
  runGeneration?: number;
}

export interface QuiescenceState {
  generation: number;
  checkedGeneration: number;
  inspection?: QuiescenceInspection;
}

export interface QuiescenceGate {
  quiescent: boolean;
  reason: string;
  faults: string[];
}

export interface AdmitResult {
  admitted: boolean;
  reason: string;
  generation?: number;
  messageId?: string;
}

export interface AdmitOptions {
  /** Test seam for injectable storage; production uses the durable inbox append. */
  store?: (
    teamName: string,
    leadName: string,
    inspection: QuiescenceInspection,
    text: string,
  ) => Promise<void>;
}

function statePath(teamName: string): string {
  return path.join(teamDir(teamName), "quiescence.json");
}

function emptyState(): QuiescenceState {
  return { generation: 0, checkedGeneration: 0 };
}

function isInspection(value: unknown): value is QuiescenceInspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Partial<QuiescenceInspection>;
  return typeof inspection.generation === "number"
    && Number.isInteger(inspection.generation)
    && inspection.generation > 0
    && typeof inspection.messageId === "string"
    && inspection.messageId.length > 0
    && (inspection.phase === "reserved" || inspection.phase === "pending" || inspection.phase === "accepted");
}

function readStateSync(filePath: string): QuiescenceState {
  if (!fs.existsSync(filePath)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<QuiescenceState>;
  if (
    typeof parsed.generation !== "number"
    || !Number.isInteger(parsed.generation)
    || parsed.generation < 0
    || typeof parsed.checkedGeneration !== "number"
    || !Number.isInteger(parsed.checkedGeneration)
    || parsed.checkedGeneration < 0
    || parsed.checkedGeneration > parsed.generation
  ) {
    throw new Error("quiescence state is unreadable");
  }
  if (parsed.inspection !== undefined && !isInspection(parsed.inspection)) {
    throw new Error("quiescence inspection is unreadable");
  }
  return {
    generation: parsed.generation,
    checkedGeneration: parsed.checkedGeneration,
    ...(parsed.inspection ? { inspection: parsed.inspection } : {}),
  };
}

function writeStateSync(filePath: string, state: QuiescenceState): void {
  atomicWriteJsonSync(filePath, state);
}

export async function readQuiescenceState(teamName: string): Promise<QuiescenceState> {
  const filePath = statePath(teamName);
  return withLock(filePath, async () => readStateSync(filePath));
}

/** Formal delegate/redelegate or a real predefined worker launch opens one generation. */
export async function openFormalGeneration(teamName: string): Promise<number> {
  const filePath = statePath(teamName);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withLock(filePath, async () => {
        const state = readStateSync(filePath);
        state.generation += 1;
        writeStateSync(filePath, state);
        return state.generation;
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("could not open a formal work generation");
}

export function quiescenceGate(
  snapshot: QuiescenceSnapshot,
  ignore?: { memberName: string; messageId: string },
): QuiescenceGate {
  const faults: string[] = [];
  let liveIdle = 0;
  for (const member of snapshot.members) {
    if (!member.alive || member.activity === "stopped") {
      faults.push(`${member.name} is ${member.alive ? "stopped" : "dead"}; unfinished work is a blocker, not a success`);
      continue;
    }
    if (member.activity !== "idle") {
      return { quiescent: false, reason: `${member.name} is ${member.activity}`, faults };
    }
    const ignored = ignore && ignore.memberName === member.name
      && member.unreadIds.includes(ignore.messageId);
    const effectiveUnread = member.unreadCount - (ignored ? 1 : 0);
    if (effectiveUnread > 0) {
      return { quiescent: false, reason: `${member.name} has pending mail`, faults };
    }
    if (member.awaitingConfirmation) {
      return { quiescent: false, reason: `${member.name} has unknown inbox acceptance`, faults };
    }
    liveIdle += 1;
  }
  if (liveIdle === 0) {
    return { quiescent: false, reason: "no live idle participant", faults };
  }
  return { quiescent: true, reason: "quiescent", faults };
}

export function formatInspection(
  snapshot: QuiescenceSnapshot,
  generation: number,
  faults: string[],
): string {
  const members = snapshot.members.map(member =>
    `- ${member.name} (${member.agentType}): ${member.alive ? "alive" : "dead"} ${member.activity}`);
  const tasks = snapshot.tasks.length > 0
    ? snapshot.tasks.map(task => `- ${task.id} [${task.status}] owner=${task.owner ?? "none"} ${task.subject}`)
    : ["- none recorded"];
  const faultLines = faults.length > 0 ? faults.map(fault => `- ${fault}`) : ["- none"];
  return [
    QUIESCENCE_MARKER,
    `Generation: ${generation}`,
    "This is an inspection opportunity, not task completion. It does not prove the work is done and it does not mark any task complete.",
    "No completion report is attached to this inspection.",
    "Members:",
    ...members,
    "Faults:",
    ...faultLines,
    "Tasks:",
    ...tasks,
    "Inspect the artifacts and unfinished states. Finish the work, or formally dispatch more work with delegate_task. An ordinary team_message does not open another inspection, even if it says to continue.",
  ].join("\n");
}

function generationIn(text: string): number | undefined {
  const match = text.match(/^Generation: (\d+)$/m);
  if (!match) return undefined;
  return Number(match[1]);
}

async function leadOf(teamName: string): Promise<Member> {
  const config = await readConfig(teamName);
  const lead = config.members.find(member => member.agentType === "lead")
    ?? config.members.find(member => member.name === "team-lead");
  if (!lead) throw new Error(`Team ${teamName} has no lead member`);
  return lead;
}

async function snapshotOf(
  teamName: string,
  liveness: QuiescenceLiveness,
): Promise<QuiescenceSnapshot> {
  const config = await readConfig(teamName);
  const lead = config.members.find(member => member.agentType === "lead")
    ?? config.members.find(member => member.name === "team-lead");
  const members: QuiescenceMemberView[] = [];
  for (const member of config.members) {
    const status = await readRuntimeStatus(teamName, member.name);
    let unread: Array<{ id: string }> = [];
    try {
      unread = await readInbox(teamName, member.name, true, false);
    } catch {
      throw new Error(`pending mail for ${member.name} could not be read`);
    }
    members.push({
      name: member.name,
      agentType: member.agentType,
      alive: liveness.isMemberAlive(teamName, member, status),
      activity: status?.activity ?? "unknown",
      unreadCount: unread.length,
      unreadIds: unread.map(message => message.id),
      awaitingConfirmation: !!status?.inboxAwaitingConfirmation,
      instanceId: status?.instanceId,
    });
  }
  const tasks = (await listTasks(teamName)).map(task => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    owner: task.owner,
  }));
  return {
    leadName: lead?.name ?? "team-lead",
    members,
    tasks,
  };
}

async function storeInspection(
  teamName: string,
  leadName: string,
  inspection: QuiescenceInspection,
  text: string,
): Promise<void> {
  const stored = await appendMessageOnce(teamName, leadName, {
    id: inspection.messageId,
    from: "pi-teams",
    text,
    timestamp: new Date().toISOString(),
    read: false,
    summary: `Quiescence inspection ${inspection.generation}`,
  });
  if (stored.id !== inspection.messageId) {
    throw new Error("inspection message id was not stored");
  }
  await markRuntimeQueuedIfIdle(teamName, leadName).catch(() => undefined);
}

/**
 * Append at most one inspection for the latest unchecked generation.
 * A failed append keeps the reserved id so the retry cannot create a second message.
 * This does not mark the generation checked and does not open a new generation.
 */
export async function admitQuiescenceInspection(
  teamName: string,
  liveness: QuiescenceLiveness,
  options: AdmitOptions = {},
): Promise<AdmitResult> {
  const store = options.store ?? storeInspection;
  const filePath = statePath(teamName);
  return withLock(filePath, async () => {
    const state = readStateSync(filePath);
    if (state.generation <= state.checkedGeneration && !state.inspection) {
      return { admitted: false, reason: "checked" };
    }

    const lead = await leadOf(teamName);
    const leadStatus = await readRuntimeStatus(teamName, lead.name);
    if (state.inspection?.phase === "accepted") {
      const sameLeader = !!leadStatus
        && leadStatus.instanceId === state.inspection.leaderInstanceId
        && leadStatus.activity !== "stopped"
        && isRuntimeProcessAlive(leadStatus);
      if (sameLeader) {
        return {
          admitted: false,
          reason: "accepted",
          generation: state.inspection.generation,
          messageId: state.inspection.messageId,
        };
      }
      delete state.inspection;
      writeStateSync(filePath, state);
    }

    if (state.inspection && state.inspection.phase !== "accepted") {
      const existing = await readInboxMessage(teamName, lead.name, state.inspection.messageId);
      if (existing && !existing.read && state.generation > state.inspection.generation) {
        const canRetag = leadStatus?.activity === "idle" && !leadStatus.inboxAwaitingConfirmation;
        if (canRetag) {
          const snapshot = await snapshotOf(teamName, liveness);
          const gate = quiescenceGate(snapshot, {
            memberName: lead.name,
            messageId: state.inspection.messageId,
          });
          if (gate.quiescent) {
            const text = formatInspection(snapshot, state.generation, gate.faults);
            const rewritten = await rewriteUnreadMessage(
              teamName,
              lead.name,
              state.inspection.messageId,
              text,
              `Quiescence inspection ${state.generation}`,
            );
            if (rewritten) {
              state.inspection.generation = state.generation;
              writeStateSync(filePath, state);
            }
          }
        }
      }
      if (!existing) {
        if (state.generation <= state.checkedGeneration) {
          delete state.inspection;
          writeStateSync(filePath, state);
          return { admitted: false, reason: "checked" };
        }
        const snapshot = await snapshotOf(teamName, liveness);
        const gate = quiescenceGate(snapshot);
        if (!gate.quiescent) {
          return {
            admitted: false,
            reason: gate.reason,
            generation: state.inspection.generation,
            messageId: state.inspection.messageId,
          };
        }
        const text = formatInspection(snapshot, state.inspection.generation, gate.faults);
        await store(teamName, snapshot.leadName, state.inspection, text);
        state.inspection.phase = "pending";
        writeStateSync(filePath, state);
        return {
          admitted: true,
          reason: "retry",
          generation: state.inspection.generation,
          messageId: state.inspection.messageId,
        };
      }
      if (existing.read && leadStatus?.activity === "idle" && !leadStatus.inboxAwaitingConfirmation) {
        delete state.inspection;
        writeStateSync(filePath, state);
      } else {
        return {
          admitted: false,
          reason: "in-flight",
          generation: state.inspection.generation,
          messageId: state.inspection.messageId,
        };
      }
    }

    if (state.generation <= state.checkedGeneration) {
      return { admitted: false, reason: "checked" };
    }
    const snapshot = await snapshotOf(teamName, liveness);
    const gate = quiescenceGate(snapshot);
    if (!gate.quiescent) return { admitted: false, reason: gate.reason };

    const inspection: QuiescenceInspection = {
      generation: state.generation,
      messageId: randomUUID(),
      phase: "reserved",
    };
    state.inspection = inspection;
    writeStateSync(filePath, state);
    const text = formatInspection(snapshot, inspection.generation, gate.faults);
    await store(teamName, snapshot.leadName, inspection, text);
    inspection.phase = "pending";
    writeStateSync(filePath, state);
    return {
      admitted: true,
      reason: "admitted",
      generation: inspection.generation,
      messageId: inspection.messageId,
    };
  });
}

export async function noteInspectionAccepted(
  teamName: string,
  input: {
    messageId: string;
    leaderInstanceId: string;
    runGeneration: number;
    deliveredText: string;
    commitGuard?: () => Promise<boolean> | boolean;
  },
): Promise<{ accepted: boolean; generation?: number }> {
  if (!input.deliveredText.includes(QUIESCENCE_MARKER)) return { accepted: false };
  if (!input.deliveredText.includes(`Message-ID: ${input.messageId}`)) return { accepted: false };
  const tagged = generationIn(input.deliveredText);
  const filePath = statePath(teamName);
  return withLock(filePath, async () => {
    const state = readStateSync(filePath);
    const inspection = state.inspection;
    if (!inspection || inspection.messageId !== input.messageId) return { accepted: false };
    if (tagged !== inspection.generation) return { accepted: false };
    if (input.commitGuard && !await input.commitGuard()) return { accepted: false };
    if (inspection.phase === "accepted") {
      const same = inspection.leaderInstanceId === input.leaderInstanceId
        && inspection.runGeneration === input.runGeneration;
      return same ? { accepted: true, generation: inspection.generation } : { accepted: false };
    }
    inspection.phase = "accepted";
    inspection.leaderInstanceId = input.leaderInstanceId;
    inspection.runGeneration = input.runGeneration;
    writeStateSync(filePath, state);
    return { accepted: true, generation: inspection.generation };
  });
}

export type AckCommitDecision = "authorized" | "revoked" | "not-ours";

export interface AckGuard {
  /**
   * Called while the coordinator lock is held, immediately before the commit
   * decision. `true`/`"authorized"` commits; `false`/`"revoked"` reports that
   * the local obligation was revoked, so the caller can keep or hand off its
   * release responsibility; `"not-ours"` means the durable record is no longer
   * owned by this writer. A thrown error propagates so the caller can retry.
   */
  stillAuthorized?: () => Promise<AckCommitDecision | boolean> | AckCommitDecision | boolean;
}

export interface AckResult {
  checked: boolean;
  decision?: AckCommitDecision;
  generation?: number;
  checkedGeneration: number;
  currentGeneration: number;
}

export async function acknowledgeAcceptedInspection(
  teamName: string,
  input: { messageId: string; leaderInstanceId: string; runGeneration: number },
  guard?: AckGuard,
): Promise<AckResult> {
  const filePath = statePath(teamName);
  return withLock(filePath, async () => {
    const state = readStateSync(filePath);
    const inspection = state.inspection;
    const unchanged: AckResult = {
      checked: false,
      decision: "not-ours",
      checkedGeneration: state.checkedGeneration,
      currentGeneration: state.generation,
    };
    if (!inspection || inspection.phase !== "accepted" || inspection.messageId !== input.messageId) return unchanged;
    if (inspection.leaderInstanceId !== input.leaderInstanceId || inspection.runGeneration !== input.runGeneration) {
      return unchanged;
    }
    // Tags prove which writer stored the record; they do not prove that writer
    // still has authority. Revalidate at the commit boundary, inside this lock,
    // so a replacement lease or a revoked ACK obligation cannot commit.
    if (guard?.stillAuthorized) {
      const decision = await guard.stillAuthorized();
      if (decision !== true && decision !== "authorized") {
        return {
          ...unchanged,
          decision: decision === false || decision === "revoked" ? "revoked" : "not-ours",
        };
      }
    }
    state.checkedGeneration = Math.max(state.checkedGeneration, inspection.generation);
    const generation = inspection.generation;
    delete state.inspection;
    writeStateSync(filePath, state);
    return {
      checked: true,
      generation,
      checkedGeneration: state.checkedGeneration,
      currentGeneration: state.generation,
    };
  });
}

export async function releaseAcceptedInspection(
  teamName: string,
  input: { messageId: string; leaderInstanceId: string; runGeneration: number },
): Promise<boolean> {
  const filePath = statePath(teamName);
  return withLock(filePath, async () => {
    const state = readStateSync(filePath);
    const inspection = state.inspection;
    if (!inspection || inspection.phase !== "accepted" || inspection.messageId !== input.messageId) return false;
    if (inspection.leaderInstanceId !== input.leaderInstanceId || inspection.runGeneration !== input.runGeneration) {
      return false;
    }
    delete state.inspection;
    writeStateSync(filePath, state);
    return true;
  });
}
