import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InboxMessage } from "./models";
import { withLock } from "./lock";
import { inboxPath, runtimeStatusPath } from "./paths";
import { markRuntimeQueuedIfIdle, readRuntimeStatusSync, withActiveRuntimeInstance, type AgentRuntimeStatus } from "./runtime";
import { withMemberControl } from "./control-state";
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

/** A reliable release uses one persisted ID, never a new ID after an error. */
export interface MessageCommit {
  sourceAgent?: string;
  instanceId?: string;
  allow?: () => boolean;
  // Synchronous, under inbox -> source-runtime locks, after the append/dedupe.
  onCommitted?: () => void;
}

export async function appendMessageOnce(
  teamName: string,
  agentName: string,
  message: InboxMessage,
  commit: MessageCommit = {},
): Promise<InboxMessage | null> {
  const file = inboxPath(teamName, agentName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    const write = () => {
      if (commit.allow && !commit.allow()) return null;
      const messages: InboxMessage[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : [];
      const existing = messages.find(m => m.id === message.id);
      if (existing && (existing.from !== message.from || existing.text !== message.text)) {
        throw new Error(`Message-ID ${message.id} already belongs to another report`);
      }
      if (!existing) {
        ensureMessageIds(messages);
        messages.push(message);
        atomicWriteJsonSync(file, messages);
      }
      commit.onCommitted?.();
      return existing ?? message;
    };
    return commit.sourceAgent && commit.instanceId
      ? withActiveRuntimeInstance(teamName, commit.sourceAgent, commit.instanceId, write)
      : write();
  });
}

/**
 * Signal only these delivered receipts that still represent unread work.
 * Hold inbox -> recipient runtime through the queue commit: a consumer cannot
 * read a receipt between the unread check and publication of queued activity.
 */
export async function markUnreadMessagesQueuedIfIdle(
  teamName: string,
  agentName: string,
  ids: readonly string[],
): Promise<boolean> {
  const file = inboxPath(teamName, agentName);
  if (!ids.length || !fs.existsSync(file)) return false;
  const deliveredIds = new Set(ids);
  return withLock(file, async () => {
    if (!fs.existsSync(file)) return false;
    const messages: InboxMessage[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!messages.some(message => deliveredIds.has(message.id) && !message.read)) return false;
    return markRuntimeQueuedIfIdle(teamName, agentName);
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

export interface ReportOptions {
  instanceId?: string;
  kind?: "report" | "idle";
  generation?: number;
  allow?: () => boolean;
  messageId?: string;
}

export type SentMessage = InboxMessage & { delivery?: "delivered" | "held" | "suppressed" };

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string,
  options: ReportOptions = {},
): Promise<SentMessage> {
  const msg: InboxMessage = {
    id: options.messageId ?? randomUUID(),
    from: fromName,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    color,
  };
  let held = false;
  let deliveredEarlier = false;
  const storedMessage = toName === "team-lead" && fromName !== "team-lead"
    ? await withMemberControl(teamName, fromName, async control => {
      const expected = options.instanceId ?? control.state.instanceId;
      const suppressedIdle = control.state.suppressIdle;
      const allowed = () => {
        control.assertOwned();
        return (!options.allow || options.allow())
          && (!options.instanceId || control.state.instanceId === options.instanceId)
          && !(options.kind === "idle" && options.generation !== undefined
            && suppressedIdle?.instanceId === options.instanceId
            && options.generation <= (suppressedIdle?.generation ?? -1));
      };
      if (!allowed()) return null;
      if (options.messageId) {
        // task_complete can commit its intent before its original send acquires
        // control. A simultaneous flush may recover that intent first. Treat
        // retained raw AND batched receipts as delivery, even after being read;
        // never re-hold/reappend it or wake an idle leader for an old receipt.
        const history = await readInbox(teamName, toName, false, false);
        if (!allowed()) return null;
        const existing = history.find(message => message.id === msg.id);
        if (existing && (existing.from !== msg.from || existing.text !== msg.text)) {
          throw new Error(`Message-ID ${msg.id} already belongs to another report`);
        }
        if (existing || history.some(message => message.from === msg.from && message.releaseReportIds?.includes(msg.id))) {
          deliveredEarlier = true;
          return msg;
        }
      }
      if (control.state.mode === "user") {
        const hold = () => {
          if (!allowed()) return null;
          if (options.kind === "idle") control.state.idle = msg;
          else if (!control.state.reports.some(report => report.id === msg.id)) control.state.reports.push(msg);
          control.save();
          held = true;
          return msg;
        };
        return expected ? withActiveRuntimeInstance(teamName, fromName, expected, hold) : hold();
      }
      return appendMessageOnce(teamName, toName, msg, {
        sourceAgent: fromName,
        instanceId: expected,
        allow: allowed,
      });
    })
    : options.messageId
      ? await appendMessageOnce(teamName, toName, msg, { allow: options.allow })
      : await appendMessage(teamName, toName, msg);
  if (!storedMessage) return { ...msg, delivery: "suppressed" };
  if (held) return { ...storedMessage, delivery: "held" };
  if (deliveredEarlier) return { ...storedMessage, delivery: "delivered" };

  // Runtime signalling is intentionally best-effort: the inbox append above is
  // the durable delivery and must not be reported as failed if runtime metadata
  // is temporarily unavailable. markRuntimeQueuedIfIdle preserves interrupted
  // and every other non-idle activity, so this send cannot auto-resume a pause.
  try {
    await markRuntimeQueuedIfIdle(teamName, toName);
  } catch (error) {
    console.error(`Message delivered, but failed to queue ${toName}:`, error);
  }

  return { ...storedMessage, delivery: "delivered" };
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
  color?: string,
  options: ReportOptions = {},
) {
  const config = await readConfig(teamName);

  // Create an array of delivery promises for all members except the sender
  const recipients = config.members.filter(member => member.name !== fromName);
  const deliveryPromises = recipients
    .map(member => sendPlainMessage(teamName, fromName, member.name, text, summary, color, options));

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
    // Optionally log individual errors
    failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
  }
  return {
    delivered: results.flatMap((result, i) => result.status === "fulfilled" && result.value.delivery === "delivered" ? [recipients[i].name] : []),
    held: results.flatMap((result, i) => result.status === "fulfilled" && result.value.delivery === "held" ? [recipients[i].name] : []),
    failed: results.flatMap((result, i) => result.status === "rejected" ? [recipients[i].name] : []),
  };
}
