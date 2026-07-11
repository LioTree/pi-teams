import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import { Member } from "./models";
import { addMember, createTeam, readConfig, updateMember } from "./teams";

describe("legacy team config preservation", () => {
  const testDir = path.join(os.tmpdir(), `pi-teams-config-${Date.now()}`);
  const configFile = path.join(testDir, "config.json");

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "configPath").mockReturnValue(configFile);
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "taskDir").mockReturnValue(path.join(testDir, "tasks"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeLegacyConfig() {
    fs.writeFileSync(configFile, JSON.stringify({
      name: "legacy-team",
      description: "",
      createdAt: 1,
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [{
        agentId: "worker@legacy-team",
        name: "worker",
        agentType: "teammate",
        joinedAt: 1,
        tmuxPaneId: "",
        cwd: "/tmp",
        subscriptions: [],
        defaultPlanRequired: true,
        planModeRequired: true,
      }],
    }));
  }

  it("reads legacy plan approval flags without modifying the config", async () => {
    writeLegacyConfig();
    const before = fs.readFileSync(configFile, "utf-8");

    const config = await readConfig("legacy-team");

    expect(config.members[0].defaultPlanRequired).toBe(true);
    expect(config.members[0].planModeRequired).toBe(true);
    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
  });

  it("preserves legacy flags during an explicit config mutation", async () => {
    writeLegacyConfig();

    await updateMember("legacy-team", "worker", { color: "green" });
    const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8"));

    expect(persisted.members[0].color).toBe("green");
    expect(persisted.members[0].defaultPlanRequired).toBe(true);
    expect(persisted.members[0].planModeRequired).toBe(true);
  });

  it("does not overwrite an existing team", async () => {
    await createTeam("test-team", "session-a", "lead-a");

    await expect(createTeam("test-team", "session-b", "lead-b"))
      .rejects.toThrow("already exists");
    expect((await readConfig("test-team")).leadAgentId).toBe("lead-a");
  });

  it("rejects duplicate member names even when additions race", async () => {
    await createTeam("test-team", "session", "lead");
    const member: Member = {
      agentId: "worker@test-team",
      name: "worker",
      agentType: "teammate",
      joinedAt: 1,
      tmuxPaneId: "",
      cwd: "/tmp",
      subscriptions: [],
    };

    const results = await Promise.allSettled([
      addMember("test-team", member),
      addMember("test-team", member),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await readConfig("test-team")).members.filter(item => item.name === "worker")).toHaveLength(1);
  });
});
