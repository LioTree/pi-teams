import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InboxMessage } from "./models";
import { withLock } from "./lock";
import { inboxPath, runtimeStatusPath } from "./paths";
import { markRuntimeQueuedIfIdle, readRuntimeStatusSync, type AgentRuntimeStatus } from "./runtime";
import { readConfig } from "./teams";
import { atomicWriteJsonSync } from "./atomic-file";

export function nowIso(): string {
  return new Date().toISOString();
}

type InboxMessageInput = Omit<InboxMessage, "id"> & { id?: string };

function hasUsableId(message: Partial<InboxMessage>): message is Partial<InboxMessage> & { id: string } {
  return typeof message.id === "string" && message.id.length > 0;
}

function ensureMessageIds(messages: InboxMessage[]): boolean {
  const seen = new Set<string>();
  let changed = false;

  for (const message of messages) {
    if (!hasUsableId(message) || seen.has(message.id)) {
      message.id = randomUUID();
      changed = true;
    }
    seen.add(message.id);
  }

  return changed;
}

export async function appendMessage(
  teamName: string,
  agentName: string,
  message: InboxMessageInput
): Promise<InboxMessage> {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return await withLock(p, async () => {
    let msgs: InboxMessage[] = [];
    if (fs.existsSync(p)) {
      msgs = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    ensureMessageIds(msgs);

    const usedIds = new Set(msgs.map(existing => existing.id));
    const requestedId = hasUsableId(message) ? message.id : undefined;
    const storedMessage: InboxMessage = {
      ...message,
      id: requestedId && !usedIds.has(requestedId) ? requestedId : randomUUID(),
    } as InboxMessage;
    msgs.push(storedMessage);
    atomicWriteJsonSync(p, msgs);
    return storedMessage;
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
    let changed = ensureMessageIds(allMsgs);
    let result = allMsgs;

    if (unreadOnly) {
      result = allMsgs.filter(m => !m.read);
    }

    if (markAsRead && result.length > 0) {
      const resultIds = new Set(result.map(message => message.id));
      for (const m of allMsgs) {
        if (resultIds.has(m.id) && !m.read) {
          m.read = true;
          changed = true;
        }
      }
    }

    if (changed) {
      atomicWriteJsonSync(p, allMsgs);
    }

    return result;
  });
}

/**
 * Marks only the messages that were successfully delivered to an agent
 * session. Messages appended after the caller's inbox snapshot remain unread.
 */
export async function markMessagesRead(
  teamName: string,
  agentName: string,
  ids: readonly string[]
): Promise<number> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return 0;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return 0;
    const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));
    let changed = ensureMessageIds(allMsgs);
    let marked = 0;
    const requestedIds = new Set(ids);

    for (const message of allMsgs) {
      if (requestedIds.has(message.id) && !message.read) {
        message.read = true;
        marked++;
        changed = true;
      }
    }

    if (changed) {
      atomicWriteJsonSync(p, allMsgs);
    }
    return marked;
  });
}

/**
 * Acknowledge ids only if `allow` still holds after both locks are acquired.
 * Lock order is inbox, then runtime. Do not hold the runtime lock while
 * waiting for the inbox lock, or a replacement can deadlock against this commit.
 * `allow` runs inside that critical section and must not await or lock again.
 */
export async function commitInboxAcknowledgement(
  teamName: string,
  agentName: string,
  ids: readonly string[],
  allow: (status: AgentRuntimeStatus | null) => boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  const inbox = inboxPath(teamName, agentName);
  if (!fs.existsSync(inbox)) return 0;
  const runtimeFile = runtimeStatusPath(teamName, agentName);

  return await withLock(inbox, async () => {
    if (!fs.existsSync(inbox)) return 0;
    return await withLock(runtimeFile, async () => {
      if (!allow(readRuntimeStatusSync(teamName, agentName))) return 0;

      const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(inbox, "utf-8"));
      let changed = ensureMessageIds(allMsgs);
      let marked = 0;
      const requestedIds = new Set(ids);
      for (const message of allMsgs) {
        if (requestedIds.has(message.id) && !message.read) {
          message.read = true;
          marked++;
          changed = true;
        }
      }
      if (changed) atomicWriteJsonSync(inbox, allMsgs);
      return marked;
    });
  });
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string
): Promise<InboxMessage> {
  const msg: InboxMessage = {
    id: randomUUID(),
    from: fromName,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    color,
  };
  const storedMessage = await appendMessage(teamName, toName, msg);

  // Runtime signalling is intentionally best-effort: the inbox append above is
  // the durable delivery and must not be reported as failed if runtime metadata
  // is temporarily unavailable. markRuntimeQueuedIfIdle preserves interrupted
  // and every other non-idle activity, so this send cannot auto-resume a pause.
  try {
    await markRuntimeQueuedIfIdle(teamName, toName);
  } catch (error) {
    console.error(`Message delivered, but failed to queue ${toName}:`, error);
  }

  return storedMessage;
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
