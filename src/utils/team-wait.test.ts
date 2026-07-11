import { describe, expect, it } from "vitest";
import { classifyTeamWaitPeer, waitForTeam } from "./team-wait";

describe("team wait state machine", () => {
  it("keeps a live running peer active without a heartbeat timeout", () => {
    const peer = classifyTeamWaitPeer({
      name: "researcher",
      agentType: "teammate",
      alive: true,
      activity: "running",
      activityChangedAt: 1,
      unreadCount: 0,
    }, 10_000_000, 60_000);

    expect(peer.progressCapable).toBe(true);
    expect(peer.stalled).toBe(false);
  });

  it("treats old starting and queued peers as stalled", () => {
    for (const activity of ["starting", "queued"] as const) {
      const peer = classifyTeamWaitPeer({
        name: activity,
        agentType: "teammate",
        alive: true,
        activity,
        activityChangedAt: 1,
        unreadCount: 0,
      }, 60_002, 60_000);

      expect(peer.progressCapable).toBe(false);
      expect(peer.stalled).toBe(true);
      expect(peer.reason).toBe("startup_stalled");
    }
  });

  it("lets unread mail make a live waiting peer progress-capable", () => {
    const peer = classifyTeamWaitPeer({
      name: "dependent",
      agentType: "teammate",
      alive: true,
      activity: "waiting",
      unreadCount: 1,
    });

    expect(peer.progressCapable).toBe(true);
    expect(peer.reason).toBe("unread_message");
  });

  it("does not let unread mail revive a stalled queued peer", () => {
    const peer = classifyTeamWaitPeer({
      name: "poisoned-queue",
      agentType: "teammate",
      alive: true,
      activity: "queued",
      activityChangedAt: 1,
      unreadCount: 1,
    }, 60_002, 60_000);

    expect(peer.progressCapable).toBe(false);
    expect(peer.stalled).toBe(true);
  });

  it("does not let unread mail revive a stopped peer", () => {
    const peer = classifyTeamWaitPeer({
      name: "stopped-worker",
      agentType: "teammate",
      alive: true,
      activity: "stopped",
      unreadCount: 1,
    });

    expect(peer.progressCapable).toBe(false);
    expect(peer.reason).toBe("stopped");
  });

  it("returns no_active_agents only after two consecutive inactive polls", async () => {
    let polls = 0;
    const result = await waitForTeam({
      consumeMessages: async () => [],
      getPeers: async () => [{
        name: "idle-worker",
        agentType: "teammate",
        alive: true,
        activity: "idle",
        unreadCount: 0,
      }],
      pollIntervalMs: 1,
      onPoll: () => { polls += 1; },
    });

    expect(result.outcome).toBe("no_active_agents");
    expect(result.timedOut).toBe(false);
    expect(polls).toBe(1);
  });

  it("returns a message before no-active or timeout outcomes", async () => {
    const result = await waitForTeam({
      consumeMessages: async () => [{
        id: "m-1",
        from: "worker",
        text: "done",
        timestamp: new Date(0).toISOString(),
        read: true,
      }],
      getPeers: async () => [],
      timeoutSeconds: 0,
    });

    expect(result.outcome).toBe("message");
    expect(result.messages).toHaveLength(1);
  });

  it("returns an acknowledged message without calling a fallible peer snapshot", async () => {
    const result = await waitForTeam({
      consumeMessages: async () => [{
        id: "m-immediate",
        from: "worker",
        text: "done",
        timestamp: new Date(0).toISOString(),
        read: true,
      }],
      getPeers: async () => { throw new Error("snapshot failed"); },
    });

    expect(result.outcome).toBe("message");
    expect(result.messages[0].id).toBe("m-immediate");
  });

  it("rechecks messages before returning no_active_agents", async () => {
    let reads = 0;
    const result = await waitForTeam({
      consumeMessages: async () => {
        reads += 1;
        return reads === 3 ? [{
          id: "m-race",
          from: "worker",
          text: "arrived at the boundary",
          timestamp: new Date(0).toISOString(),
          read: true,
        }] : [];
      },
      getPeers: async () => [],
      pollIntervalMs: 1,
    });

    expect(result.outcome).toBe("message");
    expect(result.messages[0].id).toBe("m-race");
  });

  it("supports an explicit timeout while a peer remains active", async () => {
    const result = await waitForTeam({
      consumeMessages: async () => [],
      getPeers: async () => [{
        name: "long-job",
        agentType: "teammate",
        alive: true,
        activity: "running",
        unreadCount: 0,
      }],
      timeoutSeconds: 0.002,
      pollIntervalMs: 1,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.timedOut).toBe(true);
  });
});
