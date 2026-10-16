import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxMessage } from "./models";
import { teamDir, sanitizeName, runtimeStatusPath } from "./paths";
import { getProcessStartToken, isRuntimeProcessAlive } from "./runtime";
import { withLock } from "./lock";
import { atomicWriteJsonSync } from "./atomic-file";

export type ControlMode = "team" | "user";

export interface HeldReportRelease {
  message: InboxMessage;
  reportIds: string[];
  idleId?: string;
  fingerprint: string;
}

/** Durable, narrow outbox for this member's reports to the leader, not an inbox. */
export interface MemberControlState {
  version: 1;
  mode: ControlMode;
  instanceId?: string;
  reports: InboxMessage[];
  idle?: InboxMessage;
  release?: HeldReportRelease;
  lastReleaseFingerprint?: string;
  suppressIdle?: { instanceId: string; generation: number };
}

export function controlStatePath(teamName: string, agentName: string): string {
  return path.join(teamDir(teamName), "control", `${sanitizeName(agentName)}.json`);
}

/** Read-only callers may use the last atomic snapshot, never a cached mode. */
export function readControlStateSync(teamName: string, agentName: string): MemberControlState {
  const file = controlStatePath(teamName, agentName);
  if (!fs.existsSync(file)) return { version: 1, mode: "team", reports: [] };
  const state = JSON.parse(fs.readFileSync(file, "utf-8")) as MemberControlState;
  // Fail closed on corrupt ownership/outbox data; never silently reset to team,
  // discard report content, or synthesize a release from malformed records.
  const validMessage = (message: InboxMessage) => message && typeof message.id === "string" && !!message.id
    && typeof message.from === "string" && typeof message.text === "string"
    && typeof message.timestamp === "string" && typeof message.read === "boolean";
  if (!state || state.version !== 1 || !["team", "user"].includes(state.mode) || !Array.isArray(state.reports)
    || state.reports.some(message => !validMessage(message))
    || (state.idle !== undefined && !validMessage(state.idle))
    || (state.release !== undefined && (!validMessage(state.release?.message)
      || !Array.isArray(state.release.reportIds) || state.release.reportIds.some(id => typeof id !== "string")
      || typeof state.release.fingerprint !== "string"))
    || (state.suppressIdle !== undefined && (typeof state.suppressIdle?.instanceId !== "string"
      || !Number.isSafeInteger(state.suppressIdle.generation) || state.suppressIdle.generation < 0))) {
    throw new Error(`Invalid control state for ${agentName}; preserve and repair ${file} before continuing`);
  }
  return state;
}

export interface LockedMemberControl {
  state: MemberControlState;
  assertOwned(): void;
  save(): void;
}

/**
 * Control operations can outlive the ordinary 30s stale-lock threshold (e.g.
 * delegation). Never steal a live owner's control lock. Runtime admission is
 * a synchronous try only: all contenders serialize dead-owner reclamation and
 * lock creation there, but RELEASE runtime before waiting on control or running
 * the callback. This avoids control -> runtime / runtime -> control deadlocks.
 */
async function withControlLock<T>(file: string, runtimeFile: string, fn: (assertOwned: () => void) => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const owner = JSON.stringify({ pid: process.pid, processStartToken: getProcessStartToken(process.pid), token: randomUUID() });
  const ownsLock = () => {
    try { return fs.readFileSync(lock, "utf-8") === owner; }
    catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
  };
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt++) {
    acquired = await withLock(runtimeFile, async () => {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          let alive = false;
          try {
            const stored = JSON.parse(fs.readFileSync(lock, "utf-8"));
            const previous = typeof stored === "number" ? { pid: stored } : stored;
            alive = Number.isInteger(previous?.pid) && previous.pid > 0 && isRuntimeProcessAlive(previous);
          } catch {}
          if (!alive) fs.unlinkSync(lock);
        }
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      try { fs.writeFileSync(lock, owner, { flag: "wx" }); return true; }
      catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
    });
    if (!acquired) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!acquired) throw new Error("Could not acquire control lock; its current owner may still be running. Retry explicitly.");
  const assertOwned = () => { if (!ownsLock()) throw new Error("Control lock ownership changed; obsolete operation was not committed."); };
  try { return await fn(assertOwned); }
  finally { if (ownsLock()) fs.unlinkSync(lock); }
}

/**
 * Outer lock for mode changes, leader report routing, injection, and delegation.
 * Nested order: control -> recipient inbox -> source runtime. Never acquire a
 * control lock from an inbox/runtime/task critical section.
 */
export async function withMemberControl<T>(
  teamName: string,
  agentName: string,
  fn: (control: LockedMemberControl) => Promise<T>,
): Promise<T> {
  const file = controlStatePath(teamName, agentName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withControlLock(file, runtimeStatusPath(teamName, agentName), async assertOwned => {
    assertOwned();
    const state = readControlStateSync(teamName, agentName);
    return fn({
      state,
      assertOwned,
      save() {
        assertOwned();
        atomicWriteJsonSync(file, state);
      },
    });
  });
}

export function controlSnapshot(state: MemberControlState) {
  return {
    mode: state.mode,
    heldReports: state.reports.length,
    heldIdle: !!state.idle,
    releasePending: !!state.release,
  };
}
