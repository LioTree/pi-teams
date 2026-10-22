import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import * as teams from "./teams";
import * as runtime from "./runtime";
import { allocateSession, claimSession, restoreTeamPanes } from "./team-session";
import { nextWindowIntent, windowIntentState } from "./window-intent";

let root: string;
const team = "intent-tests";
async function member() { return (await teams.readConfig(team)).members.find(m => m.name === "worker")!; }
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-window-intent-"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(root, "sessions"));
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  await teams.createTeam(team, "legacy", "lead");
  const identity = allocateSession(team, root);
  await teams.updateMember(team, "team-lead", { session: identity });
  await claimSession({ team, agent: "team-lead", identity, instanceId: "lead", pid: process.pid,
    processStartToken: runtime.getProcessStartToken(process.pid) });
  await teams.addMember(team, { agentId: "worker", name: "worker", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%old", cwd: root, subscriptions: [], session: { ...allocateSession(team, root), confirmed: true } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("window intent is independent of membership/runtime", () => {
  it("defaults legacy members to open without rewriting their records", async () => {
    const before = fs.readFileSync(paths.configPath(team), "utf8");
    expect(windowIntentState(await member())).toBe("open");
    expect(fs.readFileSync(paths.configPath(team), "utf8")).toBe(before);
    expect(nextWindowIntent(undefined, "closed", "pane-missing", 123)).toEqual({
      state: "closed", epoch: 1, changedAt: 123, reason: "pane-missing",
    });
  });

  it("rejects a stale observation and a stale close rollback after a newer explicit resume", async () => {
    const close = await teams.beginWindowClose(team, "worker", "close-member");
    expect((await member()).windowIntent?.state).toBe("closed");
    await teams.setWindowIntent(team, "worker", "open", "resume");
    expect(await teams.setWindowIntent(team, "worker", "closed", "pane-missing", 0)).toBeNull();
    expect(await teams.rollbackWindowClose(team, "worker", close.intent!.epoch, close.previousIntent)).toBe(false);
    expect((await member()).windowIntent).toMatchObject({ state: "open", epoch: 2 });
  });

  it("keeps epochs monotonic when a failed close restores open state", async () => {
    const transition = await teams.beginWindowClose(team, "worker", "close-member");
    expect(await teams.rollbackWindowClose(team, "worker", transition.intent!.epoch, transition.previousIntent)).toBe(true);
    expect((await member()).windowIntent).toMatchObject({ state: "open", epoch: 2, reason: "rollback" });
    expect(await teams.setWindowIntent(team, "worker", "closed", "pane-missing", 0)).toBeNull();
    expect(await teams.setWindowIntent(team, "worker", "closed", "pane-missing", 1)).toBeNull();
    expect((await teams.beginWindowClose(team, "worker", "close-member")).intent?.epoch).toBe(3);
  });

  it("whole close cancels pending launch while preserving open intent, and rollback preserves the prior reservation", async () => {
    await teams.updateMember(team, "worker", { recovery: { token: "pending", ownerInstanceId: "lead", phase: "launched" } });
    const transition = await teams.beginWindowClose(team, "worker", "close-team", { preserveIntent: true });
    expect(transition.changedIntent).toBe(false);
    expect(windowIntentState(await member())).toBe("open");
    expect((await member()).recovery?.phase).toBe("failed");
    expect(await teams.rollbackWindowClose(team, "worker", 0, undefined, transition.cancelledLaunch?.phase)).toBe(true);
    expect((await member()).recovery?.phase).toBe("launched");
  });

  it("does not mutate intent or reservations when the terminal refuses a late pending launch", async () => {
    await teams.updateMember(team, "worker", { recovery: { token: "pending", ownerInstanceId: "lead", phase: "launched" } });
    const before = fs.readFileSync(paths.configPath(team), "utf8");
    await expect(teams.beginWindowClose(team, "worker", "close-member", {
      requireCloseableLaunch: () => { throw new Error("cannot close"); },
    })).rejects.toThrow("cannot close");
    expect(fs.readFileSync(paths.configPath(team), "utf8")).toBe(before);
  });

  it("skips hidden members automatically, and explicit resume uses the same session with no model override", async () => {
    const original = (await member()).session!;
    await teams.setWindowIntent(team, "worker", "closed", "close-member");
    const terminal: any = { name: "tmux", spawn: vi.fn(() => "%new"), findRecoveryPane: () => undefined };
    const options = { team, leaderInstanceId: "lead", terminal, piBinary: "pi" };
    expect((await restoreTeamPanes(options))[0].status).toBe("skipped");
    expect(terminal.spawn).not.toHaveBeenCalled();
    expect((await restoreTeamPanes({ ...options, reopen: "resume" }))[0].status).toBe("restored");
    expect(terminal.spawn.mock.calls[0][0].command).toContain(original.file);
    expect(terminal.spawn.mock.calls[0][0].command).not.toMatch(/--model|--thinking/);
    expect((await member()).session).toEqual(original);
  });

  it("keeps hidden intent on a definite pre-launch failure without reusing its epoch", async () => {
    await teams.setWindowIntent(team, "worker", "closed", "close-member");
    const before = (await member()).windowIntent!.epoch;
    const terminal: any = { name: "tmux", findRecoveryPane: () => undefined,
      spawn: vi.fn(() => { throw Object.assign(new Error("terminal rejected"), { spawned: false }); }) };
    const result = await restoreTeamPanes({ team, leaderInstanceId: "lead", terminal, piBinary: "pi", reopen: "resume" });
    expect(result[0].status).toBe("blocked");
    expect((await member()).windowIntent?.state).toBe("closed");
    expect((await member()).windowIntent!.epoch).toBeGreaterThan(before);
    expect((await member()).recovery?.phase).toBe("failed");
  });

  it("a replaced lead cannot clear closed intent, including replacement just before its write", async () => {
    await teams.setWindowIntent(team, "worker", "closed", "close-member");
    const terminal: any = { name: "tmux", spawn: vi.fn() };
    const realRead = runtime.readRuntimeStatus.bind(runtime);
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (name, agent) => {
      const old = await realRead(name, agent);
      if (agent === "team-lead") await runtime.replaceRuntimeInstance(team, agent, "lead", "replacement", {});
      return old;
    });
    const result = await restoreTeamPanes({ team, leaderInstanceId: "lead", terminal, piBinary: "pi", reopen: "resume" });
    expect(result[0].status).toBe("blocked");
    expect((await member()).windowIntent?.state).toBe("closed");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });
});
