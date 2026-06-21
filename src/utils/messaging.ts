import fs from "node:fs";
import path from "node:path";
import { InboxMessage, TeamConfig } from "./models";
import { withLock } from "./lock";
import { inboxPath } from "./paths";
import { readConfig } from "./teams";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function appendMessage(teamName: string, agentName: string, message: InboxMessage) {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await withLock(p, async () => {
    let msgs: InboxMessage[] = [];
    if (fs.existsSync(p)) {
      msgs = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    msgs.push(message);
    fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
  });
}

export async function readInbox(
  teamName: string,
  agentName: string,
  unreadOnly = false,
  markAsRead = true
): Promise<InboxMessage[]> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    let result = allMsgs;

    if (unreadOnly) {
      result = allMsgs.filter(m => !m.read);
    }

    if (markAsRead && result.length > 0) {
      for (const m of allMsgs) {
        if (result.includes(m)) {
          m.read = true;
        }
      }
      fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
    }

    return result;
  });
}

export interface WaitForInboxOptions {
  pollIntervalMs?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onPoll?: () => void | Promise<void>;
}

export interface WaitForInboxResult {
  messages: InboxMessage[];
  count: number;
  waitedMs: number;
  timedOut: boolean;
}

async function validateWaitTarget(teamName: string, agentName: string): Promise<void> {
  let config: TeamConfig;
  try {
    config = await readConfig(teamName);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      throw new Error(`Team ${teamName} does not exist`);
    }
    throw error;
  }

  const isMember = config.members.some(member => member.name === agentName);
  if (!isMember) {
    throw new Error(`Agent ${agentName} is not a member of team ${teamName}`);
  }
}

function createAbortError(): Error {
  const error = new Error("wait_for_inbox aborted");
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

export async function waitForInbox(
  teamName: string,
  agentName: string,
  options: WaitForInboxOptions = {}
): Promise<WaitForInboxResult> {
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
  const timeoutMs = options.timeoutSeconds === undefined
    ? undefined
    : Math.max(0, options.timeoutSeconds * 1000);
  const startedAt = Date.now();

  if (options.signal?.aborted) throw createAbortError();
  await validateWaitTarget(teamName, agentName);

  while (true) {
    if (options.signal?.aborted) throw createAbortError();

    const messages = await readInbox(teamName, agentName, true, true);
    if (messages.length > 0) {
      return {
        messages,
        count: messages.length,
        waitedMs: Date.now() - startedAt,
        timedOut: false,
      };
    }

    await validateWaitTarget(teamName, agentName);

    const elapsed = Date.now() - startedAt;
    if (timeoutMs !== undefined && elapsed >= timeoutMs) {
      return {
        messages: [],
        count: 0,
        waitedMs: elapsed,
        timedOut: true,
      };
    }

    await options.onPoll?.();

    const remainingTimeoutMs = timeoutMs === undefined ? pollIntervalMs : timeoutMs - elapsed;
    await waitForDelay(Math.min(pollIntervalMs, Math.max(1, remainingTimeoutMs)), options.signal);
  }
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string
) {
  const msg: InboxMessage = {
    from: fromName,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    color,
  };
  await appendMessage(teamName, toName, msg);
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */
export async function broadcastMessage(
  teamName: string,
  fromName: string,
  text: string,
  summary: string,
  color?: string
) {
  const config = await readConfig(teamName);

  // Create an array of delivery promises for all members except the sender
  const deliveryPromises = config.members
    .filter((member) => member.name !== fromName)
    .map((member) => sendPlainMessage(teamName, fromName, member.name, text, summary, color));

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
    // Optionally log individual errors
    failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
  }
}
