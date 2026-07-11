import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendMessage,
  readInbox,
  sendPlainMessage,
  broadcastMessage,
  markMessagesRead,
} from "./messaging";
import { readRuntimeStatus, setRuntimeActivity } from "./runtime";
import * as paths from "./paths";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-test-" + Date.now());

function writeTeamConfig(members = ["team-lead", "sender", "receiver", "member1", "member2"]) {
  fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
    name: "test-team",
    members: members.map(name => ({ name })),
  }));
}

describe("Messaging Utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    
    // Override paths to use testDir
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "inboxes", `${agentName}.json`);
    });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation((teamName) => {
      return path.join(testDir, "config.json");
    });
    vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "runtime", `${agentName}.json`);
    });

    writeTeamConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should append a message successfully", async () => {
    const msg = { from: "sender", text: "hello", timestamp: "now", read: false };
    await appendMessage("test-team", "receiver", msg);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toBe("hello");
    expect(inbox[0].id).toEqual(expect.any(String));
  });

  it("assigns stable unique IDs to legacy inbox messages", async () => {
    const p = path.join(testDir, "inboxes", "receiver.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([
      { from: "sender", text: "old-1", timestamp: "now", read: false },
      { from: "sender", text: "old-2", timestamp: "now", read: false },
    ]));

    const firstRead = await readInbox("test-team", "receiver", false, false);
    const secondRead = await readInbox("test-team", "receiver", false, false);

    expect(firstRead.map(message => message.id)).toHaveLength(2);
    expect(new Set(firstRead.map(message => message.id)).size).toBe(2);
    expect(secondRead.map(message => message.id)).toEqual(firstRead.map(message => message.id));
  });

  it("should handle concurrent appends (Stress Test)", async () => {
    const numMessages = 100;
    const promises = [];
    for (let i = 0; i < numMessages; i++) {
      promises.push(sendPlainMessage("test-team", `sender-${i}`, "receiver", `msg-${i}`, `summary-${i}`));
    }
    
    await Promise.all(promises);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(numMessages);
    
    // Verify all messages are present
    const texts = inbox.map(m => m.text).sort();
    for (let i = 0; i < numMessages; i++) {
      expect(texts).toContain(`msg-${i}`);
    }
  });

  it("should mark messages as read", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");
    await sendPlainMessage("test-team", "sender", "receiver", "msg2", "summary2");
    
    // Read only unread messages
    const unread = await readInbox("test-team", "receiver", true, true);
    expect(unread.length).toBe(2);
    
    // Now all should be read
    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.length).toBe(2);
    expect(all.every(m => m.read)).toBe(true);
  });

  it("marks only acknowledged IDs and leaves concurrently appended messages unread", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");
    await sendPlainMessage("test-team", "sender", "receiver", "msg2", "summary2");
    const deliveryBatch = await readInbox("test-team", "receiver", true, false);

    await sendPlainMessage("test-team", "sender", "receiver", "concurrent", "concurrent");
    expect(await markMessagesRead(
      "test-team",
      "receiver",
      deliveryBatch.map(message => message.id)
    )).toBe(2);

    const unread = await readInbox("test-team", "receiver", true, false);
    expect(unread.map(message => message.text)).toEqual(["concurrent"]);
  });

  it("queues an idle recipient after durable message delivery", async () => {
    await setRuntimeActivity("test-team", "receiver", "idle", {
      activityChangedAt: 1000,
    });

    const delivered = await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "wake up",
      "wake up"
    );

    expect(delivered.id).toEqual(expect.any(String));
    expect((await readRuntimeStatus("test-team", "receiver"))?.activity).toBe("queued");
  });

  it("should broadcast message to all members except the sender", async () => {
    // Setup team config
    const config = {
      name: "test-team",
      members: [
        { name: "sender" },
        { name: "member1" },
        { name: "member2" }
      ]
    };
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify(config));
    
    await broadcastMessage("test-team", "sender", "broadcast text", "summary");

    // Check member1's inbox
    const inbox1 = await readInbox("test-team", "member1", false, false);
    expect(inbox1.length).toBe(1);
    expect(inbox1[0].text).toBe("broadcast text");
    expect(inbox1[0].from).toBe("sender");

    // Check member2's inbox
    const inbox2 = await readInbox("test-team", "member2", false, false);
    expect(inbox2.length).toBe(1);
    expect(inbox2[0].text).toBe("broadcast text");
    expect(inbox2[0].from).toBe("sender");

    // Check sender's inbox (should be empty)
    const inboxSender = await readInbox("test-team", "sender", false, false);
    expect(inboxSender.length).toBe(0);
  });

});
