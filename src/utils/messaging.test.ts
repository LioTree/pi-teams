import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendMessage, readInbox, sendPlainMessage, broadcastMessage, waitForInbox } from "./messaging";
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

  it("should return immediately when unread inbox messages already exist", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "ready", "ready");

    const result = await waitForInbox("test-team", "receiver", { pollIntervalMs: 5 });

    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(1);
    expect(result.messages[0].text).toBe("ready");
  });

  it("should wait until an unread message arrives", async () => {
    const waiting = waitForInbox("test-team", "receiver", { pollIntervalMs: 5 });

    setTimeout(() => {
      void sendPlainMessage("test-team", "sender", "receiver", "delayed", "delayed");
    }, 20);

    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(1);
    expect(result.messages[0].text).toBe("delayed");
  });

  it("should mark returned messages as read", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "consume me", "consume");

    await waitForInbox("test-team", "receiver", { pollIntervalMs: 5 });

    const unread = await readInbox("test-team", "receiver", true, false);
    expect(unread.length).toBe(0);
  });

  it("should time out when no message arrives before the deadline", async () => {
    const result = await waitForInbox("test-team", "receiver", {
      pollIntervalMs: 5,
      timeoutSeconds: 0.02,
    });

    expect(result.timedOut).toBe(true);
    expect(result.count).toBe(0);
    expect(result.messages.length).toBe(0);
  });

  it("should stop waiting when aborted", async () => {
    const controller = new AbortController();
    const waiting = waitForInbox("test-team", "receiver", {
      pollIntervalMs: 50,
      signal: controller.signal,
    });

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("should fail fast when the team does not exist", async () => {
    fs.unlinkSync(path.join(testDir, "config.json"));

    await expect(waitForInbox("test-team", "receiver", { pollIntervalMs: 5 }))
      .rejects.toThrow("Team test-team does not exist");
  });

  it("should fail fast when the agent is not a team member", async () => {
    writeTeamConfig(["team-lead", "sender"]);

    await expect(waitForInbox("test-team", "receiver", { pollIntervalMs: 5 }))
      .rejects.toThrow("Agent receiver is not a member of team test-team");
  });

  it("should stop waiting when the team is deleted while blocked", async () => {
    const waiting = waitForInbox("test-team", "receiver", { pollIntervalMs: 5 });

    setTimeout(() => {
      fs.unlinkSync(path.join(testDir, "config.json"));
    }, 20);

    await expect(waiting).rejects.toThrow("Team test-team does not exist");
  });
});
