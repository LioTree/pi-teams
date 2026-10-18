import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as paths from "./paths";
import { atomicWriteJsonSync } from "./atomic-file";
import { THINKING_LEVELS, type ThinkingLevel } from "./models";

/**
 * A request for one teammate session to change its own model. The teammate
 * extension applies it with the host `setModel` API. The teammate model is
 * never asked, so a model with no quota can still be replaced.
 * This is not a work dispatch and does not touch the inbox.
 */
export interface ModelChangeRequest {
  id: string;
  model: string;
  thinking?: ThinkingLevel;
  requestedAt: number;
}

export interface ModelChangeResult {
  requestId: string;
  ok: boolean;
  error?: string;
  appliedAt: number;
}

export function parseModelRef(spec: string): { provider: string; id: string } | undefined {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (!provider || !id || /\s/.test(provider) || /\s/.test(id)) return undefined;
  return { provider, id };
}

export function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return THINKING_LEVELS.includes(trimmed as ThinkingLevel) ? trimmed as ThinkingLevel : undefined;
}

function requestPath(team: string, agent: string) {
  return path.join(paths.teamDir(team), "model-change", `${paths.sanitizeName(agent)}.json`);
}

function resultPath(team: string, agent: string) {
  return path.join(paths.teamDir(team), "model-change", `${paths.sanitizeName(agent)}.result.json`);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function requestModelChange(
  team: string,
  agent: string,
  model: string,
  thinking?: ThinkingLevel,
  now = Date.now(),
): ModelChangeRequest {
  const request: ModelChangeRequest = { id: randomUUID(), model, requestedAt: now };
  if (thinking) request.thinking = thinking;
  atomicWriteJsonSync(requestPath(team, agent), request);
  return request;
}

export function readModelChange(team: string, agent: string): ModelChangeRequest | undefined {
  return readJson<ModelChangeRequest>(requestPath(team, agent));
}

export function readModelChangeResult(team: string, agent: string): ModelChangeResult | undefined {
  return readJson<ModelChangeResult>(resultPath(team, agent));
}

export function recordModelChangeResult(
  team: string,
  agent: string,
  result: Omit<ModelChangeResult, "appliedAt"> & { appliedAt?: number },
): void {
  atomicWriteJsonSync(resultPath(team, agent), {
    ...result,
    appliedAt: result.appliedAt ?? Date.now(),
  } satisfies ModelChangeResult);
}
