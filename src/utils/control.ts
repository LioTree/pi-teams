import { createHash, randomUUID } from "node:crypto";
import type { InboxMessage, TaskFile } from "./models";
import type { AgentActivity } from "./runtime";
import { withActiveRuntimeInstance } from "./runtime";
import { appendMessageOnce, markUnreadMessagesQueuedIfIdle, readInbox, nowIso } from "./messaging";
import { controlSnapshot, withMemberControl, type LockedMemberControl } from "./control-state";

export { controlSnapshot, readControlStateSync, withMemberControl } from "./control-state";
export type { ControlMode, LockedMemberControl } from "./control-state";

/** Normal restarts retain explicit ownership and reports; an instance is not a mode. */
export async function claimMemberControl(
  teamName: string,
  agentName: string,
  instanceId: string,
  publishRuntime: () => Promise<unknown>,
) {
  return withMemberControl(teamName, agentName, async control => {
    await publishRuntime();
    control.state.instanceId = instanceId;
    control.state.suppressIdle = undefined;
    control.save();
    return controlSnapshot(control.state);
  });
}

/** Intentional removal ends ownership, but not the durable, unflushed reports. */
export function retireMemberControl(control: LockedMemberControl): void {
  control.state.mode = "team";
  control.state.instanceId = undefined;
  control.state.suppressIdle = undefined;
  control.save();
}

export async function enterUserControl(
  teamName: string,
  agentName: string,
  instanceId: string,
  allow: () => boolean,
) {
  return withMemberControl(teamName, agentName, async control => {
    const changed = await withActiveRuntimeInstance(teamName, agentName, instanceId, () => {
      if (!allow() || control.state.instanceId !== instanceId) return false;
      if (control.state.mode !== "user") {
        control.state.mode = "user";
        control.save();
      }
      return true;
    });
    if (!changed) throw new Error("This teammate no longer owns a live runtime lease; mode was not changed.");
    return controlSnapshot(control.state);
  });
}

export interface ControlReleaseSnapshot {
  activity: AgentActivity | "unknown";
  /** All team tasks; render owned tasks, but recover this sender's notices even after reassignment. */
  tasks: TaskFile[];
  generation: number;
  settled: boolean;
}

export interface ReleaseControlOptions {
  teamName: string;
  agentName: string;
  instanceId: string;
  action: "team" | "flush";
  allow: () => boolean;
  getSnapshot: () => Promise<ControlReleaseSnapshot>;
  /** Synchronous at final runtime commit: no old settled callback may replay idle. */
  getRunState: () => Pick<ControlReleaseSnapshot, "generation" | "settled">;
}

/**
 * Only explicit local handback/flush releases these reports. The saved batch ID
 * survives failure after inbox append but before outbox cleanup. The inbox keeps
 * both read and unread messages, so a retry can dedupe an already consumed batch.
 */
export async function releaseControlReports(options: ReleaseControlOptions) {
  const { teamName, agentName, instanceId } = options;
  let batches = 0;
  const deliveredBatchIds: string[] = [];
  const result = await withMemberControl(teamName, agentName, async control => {
    const allowed = () => {
      control.assertOwned();
      return options.allow() && control.state.instanceId === instanceId;
    };
    if (!allowed()) throw new Error("This teammate no longer owns the control lease; reports were not released.");

    const deliverPrepared = async () => {
      const prepared = control.state.release;
      if (!prepared) return;
      const delivered = await appendMessageOnce(teamName, "team-lead", prepared.message, {
        sourceAgent: agentName,
        instanceId,
        allow: allowed,
        onCommitted() {
          const included = new Set(prepared.reportIds);
          control.state.reports = control.state.reports.filter(report => !included.has(report.id));
          if (control.state.idle?.id === prepared.idleId) control.state.idle = undefined;
          control.state.lastReleaseFingerprint = prepared.fingerprint;
          control.state.release = undefined;
          control.save();
        },
      });
      if (!delivered) throw new Error("Runtime stopped, changed instance, or shut down before report release.");
      batches += 1; // Finalized cleanup, not necessarily new unread work.
      deliveredBatchIds.push(prepared.message.id);
    };

    // Finish a previous release first. A newer report must not be erased by the
    // old cleanup, nor appended to a batch the leader may already have consumed.
    await deliverPrepared();
    const snapshot = await options.getSnapshot();
    if (!allowed()) throw new Error("Runtime ownership changed while collecting the handoff snapshot.");

    // task_complete commits the notice intent with the task. A failed initial
    // notification cannot be recovered by re-completing an already complete task.
    // Recover it here, deduping raw delivery AND delivery inside a prior batch.
    const leaderInbox = await readInbox(teamName, "team-lead", false, false);
    const deliveredIds = new Set(leaderInbox.flatMap(message => [message.id, ...(message.releaseReportIds ?? [])]));
    let recovered = false;
    for (const task of snapshot.tasks) {
      const notice = task.completionNotice;
      if (notice?.from === agentName && !deliveredIds.has(notice.id) && !control.state.reports.some(report => report.id === notice.id)) {
        control.state.reports.push(notice);
        recovered = true;
      }
    }
    if (recovered) control.save();

    const taskStates = snapshot.tasks.filter(task => task.owner === agentName).map(task => ({
      id: task.id, subject: task.subject, status: task.status, owner: task.owner,
      completionSummary: task.metadata?.completionSummary,
    }));
    const fingerprint = createHash("sha256").update(JSON.stringify({
      action: options.action,
      instanceId,
      generation: snapshot.generation,
      activity: snapshot.activity,
      tasks: taskStates,
    })).digest("hex");
    const alreadyTeam = control.state.mode === "team";
    const hasPending = control.state.reports.length > 0 || !!control.state.idle;
    const needsBatch = hasPending || ((!alreadyTeam || batches > 0) && control.state.lastReleaseFingerprint !== fingerprint);
    if (needsBatch) {
      const reportIds = control.state.reports.map(report => report.id);
      const message: InboxMessage = {
        id: randomUUID(),
        from: agentName,
        timestamp: nowIso(),
        read: false,
        summary: `${agentName}: ${options.action === "team" ? "user handback" : "explicit report flush"}`,
        releaseReportIds: reportIds,
        text: [
          `Human-control report release from ${agentName}.`,
          `Requested action: ${options.action === "team" ? "return control to team" : "flush reports; keep current control mode"}.`,
          "Handback is NOT task completion. Held messages can be progress reports, not results.",
          `Activity snapshot collected for this release (may change while delivery waits): ${snapshot.activity}.`,
          "Current owned task states:",
          ...(taskStates.length ? taskStates.map(task => `- ${task.id} [${task.status}] ${task.subject}${task.completionSummary ? `\n  Stored completion summary: ${task.completionSummary}` : ""}`) : ["- none; this is not a claim that work completed"]),
          "Held explicit leader reports (original content):",
          ...(control.state.reports.length ? control.state.reports.flatMap(report => [
            `--- Message-ID: ${report.id}; sent: ${report.timestamp}; summary: ${report.summary ?? ""} ---`,
            report.text,
          ]) : ["- No completion report was provided in this release. Tasks may remain unfinished."]),
          "Latest held idle snapshot (redundant idle snapshots coalesced):",
          control.state.idle?.text ?? "- none",
        ].join("\n"),
      };
      control.state.release = { message, reportIds, idleId: control.state.idle?.id, fingerprint };
      control.save(); // Persist intent BEFORE the irreversible mailbox append.
      await deliverPrepared();
    }

    const committed = await withActiveRuntimeInstance(teamName, agentName, instanceId, () => {
      if (!allowed()) return false;
      let changed = false;
      if (options.action === "team" && control.state.mode !== "team") {
        control.state.mode = "team";
        changed = true;
      }
      // The old settled handler can still be collecting task lines. Do not let
      // it publish another idle for the run already covered by this UI action.
      // A still-running run gets NO suppression: its eventual completion is new.
      const run = options.getRunState();
      if (run.settled && (!alreadyTeam || hasPending || batches > 0)) {
        control.state.suppressIdle = { instanceId, generation: run.generation };
        changed = true;
      }
      if (changed) control.save();
      return true;
    });
    if (!committed) throw new Error("Runtime stopped or was replaced before handback committed; inspect /team-mode and retry explicitly.");
    return { ...controlSnapshot(control.state), batches };
  });
  if (batches > 0) {
    await markUnreadMessagesQueuedIfIdle(teamName, "team-lead", deliveredBatchIds).catch(error => {
      console.error("Reports delivered, but leader queue metadata could not be updated:", error);
    });
  }
  return result;
}
