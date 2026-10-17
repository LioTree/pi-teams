import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import { allocateSession, canonicalSessionFile, claimSession, findSessionMember, restoreTeamPanes } from "./team-session";
import type { TeamSession } from "./models";

let root: string;
let lead: TeamSession;
let worker: TeamSession;
const team = "recovery";
const token = runtime.getProcessStartToken(process.pid);
function config() { return JSON.parse(fs.readFileSync(paths.configPath(team), "utf8")); }
async function claim(identity = lead, instanceId = "leader", agent = "team-lead", extra: any = {}) {
  return claimSession({ team, agent, identity, instanceId, pid: process.pid, processStartToken: token, ...extra });
}
function adapter() {
  const panes = new Map<string, string>();
  return { name: "tmux", panes,
    spawn: vi.fn((options: any) => { panes.set(options.recoveryToken, "%new"); return "%new"; }),
    findRecoveryPane: (nonce: string) => panes.get(nonce),
  };
}
async function restore(terminal: any, current = () => true) {
  return restoreTeamPanes({ team, leaderInstanceId: "leader", terminal, piBinary: "pi", anchorPaneId: "%lead-new", current });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-recovery-unit-"));
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockReturnValue([team]);
  await teams.createTeam(team, "temporary", "lead");
  lead = allocateSession(team, root);
  fs.mkdirSync(path.join(root, "project with space"));
  worker = allocateSession(team, path.join(root, "project with space"));
  await teams.updateMember(team, "team-lead", { session: lead });
  await teams.addMember(team, { name: "worker", agentId: "worker@recovery", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%recycled", cwd: worker.cwd, subscriptions: [], session: { ...worker, confirmed: true }, model: "obsolete/model", thinking: "max" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("persistent session ownership and bounded pane recovery", () => {
  it("preallocates a valid SDK-openable exact identity before launch", () => {
    const manager = SessionManager.open(lead.file);
    expect(manager.getSessionId()).toBe(lead.id);
    expect(canonicalSessionFile(manager.getSessionFile()!)).toBe(lead.file);
    expect(findSessionMember(lead)?.member.name).toBe("team-lead");
    const cloned = SessionManager.create(root, path.join(root, "clones"));
    expect(findSessionMember({ ...lead, id: cloned.getSessionId(), file: cloned.getSessionFile()! })).toBeUndefined();
  });

  it("uses Pi's normal per-project/agentDir storage and SDK resume discovery outside deletable metadata", async () => {
    const agentDir = path.join(os.homedir(), "persistent agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/persistent agent");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
    const project = path.join(root, "project with space");
    const allocated = allocateSession(team, project);
    const control = SessionManager.create(project);
    expect(path.dirname(allocated.file)).toBe(control.getSessionDir());
    expect(allocated.file.startsWith(agentDir + path.sep)).toBe(true);
    expect(allocated.agentDir).toBe(agentDir);
    expect(allocated.file.startsWith(path.dirname(paths.teamDir(team)) + path.sep)).toBe(false);
    expect(allocated.file.startsWith(path.dirname(paths.taskDir(team)) + path.sep)).toBe(false);
    const manager = SessionManager.open(allocated.file);
    expect(manager.getSessionId()).toBe(allocated.id);
    manager.appendModelChange("fixture", "retained-model");
    manager.appendThinkingLevelChange("high");
    manager.appendMessage({ role: "user", content: "normal resume storage", timestamp: Date.now() });
    expect((await SessionManager.list(project)).some(info => info.id === allocated.id && info.path === allocated.file)).toBe(true);
    // An explicit unsafe storage override fails closed, not into team deletion.
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(paths.teamDir(team), "sessions"));
    expect(() => allocateSession(team, project)).toThrow("overlaps deletable");
  });

  it("only one concurrent leader claimant gets the live lease", async () => {
    const results = await Promise.allSettled([claim(lead, "first"), claim(lead, "second")]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
    const owner = (await runtime.readRuntimeStatus(team, "team-lead"))!;
    expect(["first", "second"]).toContain(owner.instanceId);
    await expect(claim(lead, "third")).rejects.toThrow("another live process");
  });

  it("serializes two real subprocess claimers so only one owns a live member", async () => {
    fs.mkdirSync(path.join(root, ".pi"));
    fs.symlinkSync(path.join(root, "teams"), path.join(root, ".pi", "teams"));
    const fixture = path.join(root, "claim-fixture.cjs");
    fs.writeFileSync(fixture, `
const { createRequire } = require('node:module');
const req = createRequire(process.argv[2] + '/node_modules/@earendil-works/pi-coding-agent/package.json');
const jiti = req('jiti').createJiti(__filename, { moduleCache: false });
const { claimSession } = jiti(process.argv[2] + '/src/utils/team-session.ts');
const { getProcessStartToken } = jiti(process.argv[2] + '/src/utils/runtime.ts');
const identity = JSON.parse(process.argv[3]);
process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
claimSession({team:'recovery',agent:'team-lead',identity,instanceId:String(process.pid),pid:process.pid,
  processStartToken:getProcessStartToken(process.pid)}).then(() => console.log('CLAIMED'), () => console.log('REFUSED'));
`);
    const children = [1, 2].map(() => spawn(process.execPath, [fixture, process.cwd(), JSON.stringify(lead)], {
      env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent") }, stdio: ["pipe", "pipe", "pipe"],
    }));
    try {
      const outcomes = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
        let text = ""; let errors = "";
        child.stderr.on("data", chunk => { errors += chunk; });
        child.stdout.on("data", chunk => { text += chunk; if (text.includes("CLAIMED")) resolve("CLAIMED"); else if (text.includes("REFUSED")) resolve("REFUSED"); });
        child.on("error", reject); child.on("exit", () => { if (!text.includes("CLAIMED") && !text.includes("REFUSED")) reject(new Error(errors)); });
      })));
      expect(outcomes.sort()).toEqual(["CLAIMED", "REFUSED"]);
    } finally {
      const exits = children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); }));
      children.forEach(child => child.stdin.end()); await Promise.all(exits);
    }
  }, 15000);

  it("recovers a dead PID and rejects copied identity at another canonical file", async () => {
    await runtime.setRuntimeActivity(team, "team-lead", "running", { instanceId: "dead", pid: 99999999, sessionId: lead.id, sessionFile: lead.file });
    expect((await claim()).instanceId).toBe("leader");
    const copy = path.join(root, "copy.jsonl"); fs.copyFileSync(lead.file, copy);
    await expect(claim({ ...lead, file: copy }, "copied")).rejects.toThrow("no exact saved Pi session");
  });

  it("checks the actual process-start token instead of treating recycled PID as authority", async () => {
    await runtime.setRuntimeActivity(team, "team-lead", "running", { instanceId: "stale", pid: process.pid, processStartToken: "wrong-token" });
    expect((await claim()).instanceId).toBe("leader");
  });

  it("quit/stopped retains membership, but a still-attached live stopped owner is refused", async () => {
    await claim();
    await runtime.updateRuntimeStatusForInstance(team, "team-lead", "leader", { activity: "stopped" });
    await expect(claim(lead, "second")).rejects.toThrow("another live process");
    await runtime.updateRuntimeStatusForInstance(team, "team-lead", "leader", { detached: true });
    expect((await claim(lead, "second")).instanceId).toBe("second");
    expect(config().members).toHaveLength(2);
  });

  it("restores exact session and new anchor without model/thinking defaults, task/mail/generation mutation", async () => {
    await claim();
    const task = path.join(paths.taskDir(team), "42.json"); fs.writeFileSync(task, '{"id":"42","owner":"worker","status":"in_progress"}');
    const mail = path.join(paths.teamDir(team), "inboxes.json"); fs.writeFileSync(mail, '[{"id":"unchanged"}]');
    const generation = path.join(paths.teamDir(team), "quiescence.json"); fs.writeFileSync(generation, '{"generation":7,"checkedGeneration":6}');
    const before = [task, mail, generation].map(file => fs.readFileSync(file, "utf8"));
    const terminal = adapter();
    expect((await restore(terminal))[0].status).toBe("restored");
    const launch = terminal.spawn.mock.calls[0][0];
    expect(launch.command).toContain("--session");
    expect(launch.command).toContain(worker.file);
    expect(launch.command).not.toMatch(/--model|--thinking|continue|Assigned/);
    expect(launch).toMatchObject({ name: "worker", cwd: worker.cwd, anchorPaneId: "%lead-new" });
    expect([task, mail, generation].map(file => fs.readFileSync(file, "utf8"))).toEqual(before);
    // A repeated startup reconciles by nonce and does not launch another process.
    expect((await restore(terminal))[0].status).toBe("pending");
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale launch nonce without consuming a newer member reservation", async () => {
    await teams.updateMember(team, "worker", { recovery: { token: "current", ownerInstanceId: "leader", phase: "reserved" } });
    await expect(claim(worker, "stale-worker", "worker", { recoveryToken: "old" })).rejects.toThrow("superseded");
    expect(config().members[1].recovery).toMatchObject({ token: "current", phase: "reserved" });
    expect((await claim(worker, "worker", "worker", { recoveryToken: "current" })).sessionId).toBe(worker.id);
    expect(config().members[1].recovery.phase).toBe("attached");
  });

  it("keeps a live peer even when its pane is absent or recycled", async () => {
    await claim();
    await runtime.setRuntimeActivity(team, "worker", "interrupted", { instanceId: "peer", pid: process.pid, processStartToken: token, sessionId: worker.id, sessionFile: worker.file });
    const terminal = adapter();
    expect((await restore(terminal))[0].status).toBe("alive");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("preserves paused and unknown acceptance metadata through stop and claim", async () => {
    await runtime.setRuntimeActivity(team, "worker", "stopped", { pid: 99999999, paused: true,
      inboxAwaitingConfirmation: { messageIds: ["unknown"], since: 1, note: "unknown" } });
    const status = await claim(worker, "new-worker", "worker");
    expect(status.activity).toBe("interrupted");
    expect(status.inboxAwaitingConfirmation?.messageIds).toEqual(["unknown"]);
  });

  it("does not resurrect a member explicitly removed from the roster", async () => {
    await claim(); await teams.removeMember(team, "worker");
    const terminal = adapter();
    expect(await restore(terminal)).toEqual([]);
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("reports missing/corrupt/unmapped original sessions without deleting data", async () => {
    await claim(); const terminal = adapter();
    fs.unlinkSync(worker.file);
    expect((await restore(terminal))[0]).toMatchObject({ status: "blocked", note: expect.stringContaining("session") });
    fs.writeFileSync(worker.file, "corrupt");
    expect((await restore(terminal))[0].status).toBe("blocked");
    await teams.updateMember(team, "worker", { session: undefined });
    expect((await restore(terminal))[0].note).toContain("no saved Pi session");
    expect(config().members).toHaveLength(2);
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("reconciles a real config-rename failure after spawn by nonce, never spawns twice", async () => {
    await claim(); const terminal = adapter();
    const rename = fs.renameSync.bind(fs); let failed = false;
    terminal.spawn.mockImplementation((options: any) => {
      terminal.panes.set(options.recoveryToken, "%partial");
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!failed && String(to) === paths.configPath(team)) { failed = true; throw new Error("post-launch config rename"); }
        return rename(from, to);
      });
      return "%partial";
    });
    expect((await restore(terminal))[0].status).toBe("blocked");
    expect((await restore(terminal))[0]).toMatchObject({ status: "pending", note: expect.stringContaining("nonce-matched") });
    expect(config().members[1].tmuxPaneId).toBe("%partial");
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("retains unknown launch reservations and safely retries a definite no-spawn failure", async () => {
    await claim(); const terminal = adapter();
    terminal.spawn.mockImplementationOnce(() => { throw Object.assign(new Error("not spawned"), { spawned: false }); });
    expect((await restore(terminal))[0].status).toBe("blocked");
    expect(config().members[1].recovery.phase).toBe("failed");
    terminal.spawn.mockImplementationOnce(() => { throw new Error("launch outcome unknown"); });
    expect((await restore(terminal))[0].status).toBe("blocked");
    expect((await restore(terminal))[0].note).toContain("unknown");
    expect(terminal.spawn).toHaveBeenCalledTimes(2);
  });

  it("rechecks detach/replacement after a real config lock wait", async () => {
    await claim(); const terminal = adapter();
    const lock = `${paths.configPath(team)}.lock`; fs.writeFileSync(lock, "fixture");
    let active = true; const pending = restore(terminal, () => active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active = false; fs.unlinkSync(lock);
    expect((await pending)[0].status).toBe("blocked");
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("does not take over orphan live PID evidence just because its runtime file is absent", async () => {
    fs.writeFileSync(paths.leadSessionPath(team), JSON.stringify({ pid: process.pid, processStartToken: token }));
    await expect(claim()).rejects.toThrow("live PID evidence");
    fs.unlinkSync(paths.leadSessionPath(team)); await claim();
    fs.writeFileSync(path.join(paths.teamDir(team), "worker.pid"), String(process.pid));
    const terminal = adapter();
    expect((await restore(terminal))[0]).toMatchObject({ status: "blocked", note: expect.stringContaining("live PID evidence") });
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("does not block lead attachment on a non-tmux restoration limit or advisory PID write error", async () => {
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === paths.leadSessionPath(team)) throw new Error("advisory unavailable");
      return rename(from, to);
    });
    expect((await claim()).instanceId).toBe("leader");
    expect((await restore({ name: "other", spawn: vi.fn() }))[0]).toMatchObject({ status: "blocked", note: expect.stringContaining("tmux") });
  });
});
