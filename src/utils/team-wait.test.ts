import { describe, expect, it, vi } from "vitest";
import { classifyTeamWaitPeer, interruptedPeerHoldsWait, waitForTeam } from "./team-wait";

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

  it("does not let unread mail or age make a live interrupted peer progress-capable", () => {
    const peer = classifyTeamWaitPeer({
      name: "paused",
      agentType: "teammate",
      alive: true,
      activity: "interrupted",
      activityChangedAt: 1,
      unreadCount: 4,
    }, 10_000_000, 60_000);

    expect(peer.progressCapable).toBe(false);
    expect(peer.stalled).toBe(false);
    expect(peer.reason).toBe("interrupted");
    expect(interruptedPeerHoldsWait(peer)).toBe(true);
  });

  it("does not let a dead or stopped interrupted peer hold a wait", () => {
    const dead = classifyTeamWaitPeer({
      name: "gone",
      agentType: "teammate",
      alive: false,
      activity: "interrupted",
      unreadCount: 2,
    });
    const stopped = classifyTeamWaitPeer({
      name: "stopped-worker",
      agentType: "teammate",
      alive: true,
      activity: "stopped",
      unreadCount: 2,
    });

    expect(dead.reason).toBe("dead");
    expect(dead.progressCapable).toBe(false);
    expect(interruptedPeerHoldsWait(dead)).toBe(false);
    expect(stopped.reason).toBe("stopped");
    expect(interruptedPeerHoldsWait(stopped)).toBe(false);
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

  it("still treats all-waiting peers as inactive", async () => {
    const result = await waitForTeam({
      consumeMessages: async () => [],
      getPeers: async () => [{
        name: "waiter",
        agentType: "teammate",
        alive: true,
        activity: "waiting",
        unreadCount: 0,
      }],
      pollIntervalMs: 1,
    });

    expect(result.outcome).toBe("no_active_agents");
    expect(result.members[0].reason).toBe("waiting");
  });

  it("keeps an indefinite wait open across interrupted polls until a message arrives", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const pending = waitForTeam({
        consumeMessages: async () => polls >= 4 ? [reportMessage()] : [],
        getPeers: async () => [liveInterruptedPeer()],
        pollIntervalMs: 1000,
        onPoll: () => { polls += 1; },
      });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(3000);
      expect(polls).toBeGreaterThanOrEqual(3);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result.outcome).toBe("message");
      expect(result.messages[0].id).toBe("final-report");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires an explicit timeout while a peer stays interrupted", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const pending = waitForTeam({
        consumeMessages: async () => [],
        getPeers: async () => [liveInterruptedPeer()],
        timeoutSeconds: 5,
        pollIntervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result.outcome).toBe("timeout");
      expect(result.timedOut).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(5000);
      expect(result.members[0]).toMatchObject({
        activity: "interrupted",
        progressCapable: false,
        stalled: false,
        reason: "interrupted",
        unreadCount: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the final inactivity consume when cancellation wins before acknowledgement", async () => {
    const controller = new AbortController();
    let reads = 0;
    const pending = waitForTeam({
      consumeMessages: async () => {
        reads += 1;
        if (reads < 3) return [];
        controller.abort();
        const error = new Error("aborted before commit");
        error.name = "AbortError";
        throw error;
      },
      getPeers: async () => [],
      pollIntervalMs: 1,
      inactivePolls: 2,
      signal: controller.signal,
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(3);
  });

  it("keeps a committed message result if the signal aborts after consumption returns", async () => {
    const controller = new AbortController();
    const result = await waitForTeam({
      consumeMessages: async () => {
        controller.abort();
        return [reportMessage()];
      },
      getPeers: async () => {
        throw new Error("snapshot after a committed message");
      },
      signal: controller.signal,
    });
    expect(result.outcome).toBe("message");
    expect(result.messages[0].id).toBe("final-report");
    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects promptly when the caller aborts during an interrupted wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = waitForTeam({
        consumeMessages: async () => [],
        getPeers: async () => [liveInterruptedPeer()],
        pollIntervalMs: 60_000,
        signal: controller.signal,
      });
      const rejected = pending.then(() => {
        throw new Error("wait resolved");
      }, (error: unknown) => error);
      await Promise.resolve();
      controller.abort();
      await expect(rejected).resolves.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows interrupted to running and then returns the final report", async () => {
    vi.useFakeTimers();
    try {
      let phase: "interrupted" | "running" | "reported" = "interrupted";
      let polls = 0;
      const pending = waitForTeam({
        consumeMessages: async () => phase === "reported" ? [reportMessage()] : [],
        getPeers: async () => [{
          ...liveInterruptedPeer(),
          activity: phase === "interrupted" ? "interrupted" : "running",
          unreadCount: phase === "interrupted" ? 3 : 0,
        }],
        pollIntervalMs: 1000,
        onPoll: () => {
          polls += 1;
          if (polls === 2) phase = "running";
          if (polls === 4) phase = "reported";
        },
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result.outcome).toBe("message");
      expect(result.messages[0].text).toBe("implementation done");
      expect(polls).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["dead", "stopped"] as const)("permits inactivity after an interrupted peer becomes %s", async (next) => {
    vi.useFakeTimers();
    try {
      let released = false;
      const pending = waitForTeam({
        consumeMessages: async () => [],
        getPeers: async () => [released ? {
          name: "paused",
          agentType: "teammate",
          alive: next !== "dead",
          activity: next === "stopped" ? "stopped" as const : "interrupted" as const,
          unreadCount: 1,
        } : liveInterruptedPeer()],
        pollIntervalMs: 1000,
        onPoll: () => { released = true; },
      });
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.outcome).toBe("no_active_agents");
      expect(result.members[0].progressCapable).toBe(false);
      expect(result.members[0].reason).toBe(next === "dead" ? "dead" : "stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

function liveInterruptedPeer() {
  return {
    name: "paused",
    agentType: "teammate",
    alive: true,
    activity: "interrupted" as const,
    activityChangedAt: 1,
    unreadCount: 3,
  };
}

function reportMessage() {
  return {
    id: "final-report",
    from: "paused",
    text: "implementation done",
    timestamp: new Date(0).toISOString(),
    read: true,
  };
}
