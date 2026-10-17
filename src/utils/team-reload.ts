import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as paths from "./paths";
import { atomicWriteJsonSync } from "./atomic-file";

/**
 * A team-wide request to reload extension code from disk. It is not a work
 * dispatch: it opens no quiescence generation and touches no task or inbox.
 */
export interface ReloadRequest {
  id: string;
  requestedAt: number;
}

export interface ReloadReceipt {
  requestId: string;
  pid: number;
  reloadedAt: number;
}

function requestPath(team: string) {
  return path.join(paths.teamDir(team), "reload", "request.json");
}

function receiptPath(team: string, agent: string) {
  return path.join(paths.teamDir(team), "reload", `${paths.sanitizeName(agent)}.json`);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function requestTeamReload(team: string, now = Date.now()): ReloadRequest {
  const request = { id: randomUUID(), requestedAt: now };
  atomicWriteJsonSync(requestPath(team), request);
  return request;
}

export function readReloadRequest(team: string): ReloadRequest | undefined {
  return readJson<ReloadRequest>(requestPath(team));
}

export function readReloadReceipt(team: string, agent: string): ReloadReceipt | undefined {
  return readJson<ReloadReceipt>(receiptPath(team, agent));
}

export function recordReloaded(team: string, agent: string, requestId: string, pid = process.pid, now = Date.now()): void {
  atomicWriteJsonSync(receiptPath(team, agent), { requestId, pid, reloadedAt: now } satisfies ReloadReceipt);
}

/**
 * Code loaded after the request already reflects what was on disk then, so a
 * reload re-imports the module with a newer `loadedAt` and cannot loop.
 */
export function reloadDue(request: ReloadRequest | undefined, loadedAt: number): boolean {
  return !!request && loadedAt <= request.requestedAt;
}

export function isReloadedFor(request: ReloadRequest, receipt: ReloadReceipt | undefined): boolean {
  return !!receipt && receipt.requestId === request.id;
}
