import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import * as messaging from "../src/utils/messaging";
import { allocateSession, claimSession, restoreTeamPanes } from "../src/utils/team-session";
import { openFormalGeneration, readQuiescenceState } from "../src/utils/quiescence";
import { readReloadReceipt, readReloadRequest, requestTeamReload } from "../src/utils/team-reload";
import type { TeamSession } from "../src/utils/models";

vi.mock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => null }));
let root: string;
let leadIdentity: TeamSession;
let peerIdentity: TeamSession;
const team = "reload-team";
const loaded: any[] = [];

function make(identity: TeamSession) {
  const handlers = new Map<string, any>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const sent: string[] = [];
  let idle = true;
  const ctx: any = { sessionManager: SessionManager.open(identity.file), isIdle: () => idle, cwd: root,
    reload: vi.fn(async () => {}), shutdown: vi.fn(), ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() } };
  extension({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text) } as any);
  const object = { handlers, tools, commands, sent, ctx, setIdle: (value: boolean) => { idle = value; },
    emit: (name: string, event: any = {}) => handlers.get(name)({ type: name, ...event }, ctx),
    reloadCommands: () => sent.filter(text => text.startsWith("/team-reload-self ")) };
  loaded.push(object); return object;
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const nextPoll = () => new Promise(resolve => setTimeout(resolve, 1100));

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-reload-"));
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockReturnValue([team]);
  vi.stubEnv("PI_TEAM_NAME", undefined); vi.stubEnv("PI_AGENT_NAME", undefined); vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", undefined);
  await teams.createTeam(team, "legacy", "lead");
  leadIdentity = allocateSession(team, root); peerIdentity = allocateSession(team, root);
  await teams.updateMember(team, "team-lead", { session: leadIdentity });
  await teams.addMember(team, { name: "peer", agentId: "peer@reload", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%peer", cwd: root, subscriptions: [], session: { ...peerIdentity, confirmed: true } });
});
afterEach(async () => {
  for (const target of loaded.splice(0)) await target.emit("session_shutdown").catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});

describe("team-wide reload", () => {
  it("lead request reloads an idle peer through its own command, once", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start", { reason: "startup" });
    const peer = make(peerIdentity); await peer.emit("session_start", { reason: "startup" }); await drain();
    await lead.commands.get("team-reload").handler("", lead.ctx);
    const request = readReloadRequest(team)!;
    await nextPoll(); await drain();
    expect(peer.reloadCommands()).toEqual([`/team-reload-self ${request.id}`]);
    await peer.commands.get("team-reload-self").handler(request.id, peer.ctx);
    expect(peer.ctx.reload).toHaveBeenCalledTimes(1);
    // A stale or mismatched dispatch does nothing.
    await peer.commands.get("team-reload-self").handler("other", peer.ctx);
    expect(peer.ctx.reload).toHaveBeenCalledTimes(1);
    await peer.emit("session_shutdown", { reason: "reload" });
    expect(lead.reloadCommands()).toEqual([`/team-reload-self ${request.id}`]);
  }, 10_000);

  it("a busy peer waits until its run finishes", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    peer.setIdle(false); await peer.emit("agent_start");
    await lead.commands.get("team-reload").handler("", lead.ctx);
    await nextPoll(); await drain();
    expect(peer.reloadCommands()).toEqual([]);
    peer.setIdle(true); await peer.emit("agent_settled", { aborted: false });
    await nextPoll(); await drain();
    expect(peer.reloadCommands()).toHaveLength(1);
  }, 10_000);

  it("an interrupted peer may reload and its pause is persisted across the reload", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    const peer = make(peerIdentity); await peer.emit("session_start"); await peer.emit("agent_start");
    await peer.emit("agent_settled", { aborted: true }); await drain();
    await lead.commands.get("team-reload").handler("", lead.ctx);
    await nextPoll(); await drain();
    const request = readReloadRequest(team)!;
    expect(peer.reloadCommands()).toEqual([`/team-reload-self ${request.id}`]);
    await peer.commands.get("team-reload-self").handler(request.id, peer.ctx);
    await peer.emit("session_shutdown", { reason: "reload" });
    const reloaded = make(peerIdentity); await reloaded.emit("session_start", { reason: "reload" }); await drain();
    expect(await runtime.readRuntimeStatus(team, "peer")).toMatchObject({ activity: "interrupted", paused: true });
  }, 10_000);

  it("unconfirmed inbox delivery defers the reload", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    await messaging.appendMessage(team, "peer", { from: "team-lead", text: "pending mail", timestamp: new Date(0).toISOString(), read: false });
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    expect(peer.sent.join("\n")).toContain("pending mail");
    await lead.commands.get("team-reload").handler("", lead.ctx);
    await nextPoll(); await drain();
    expect(peer.reloadCommands()).toEqual([]);
  }, 10_000);

  it("code loaded after the request is current: receipt, no reload", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    const request = requestTeamReload(team, 0);
    await nextPoll(); await drain();
    expect(peer.reloadCommands()).toEqual([]);
    expect(readReloadReceipt(team, "peer")?.requestId).toBe(request.id);
    await lead.commands.get("team-reload").handler("status", lead.ctx);
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("peer: reloaded");
  }, 10_000);

  it("a peer mid-reload stays live: lead restoration retains it instead of launching a duplicate", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await peer.emit("session_shutdown", { reason: "reload" });
    expect(await runtime.readRuntimeStatus(team, "peer")).toMatchObject({ activity: "idle", reloading: true });
    expect((await runtime.readRuntimeStatus(team, "peer"))?.detached).toBeFalsy();
    const leadStatus = (await runtime.readRuntimeStatus(team, "team-lead"))!;
    const spawns: any[] = [];
    const outcomes = await restoreTeamPanes({ team, leaderInstanceId: leadStatus.instanceId!, piBinary: "pi",
      terminal: { name: "tmux", spawn: (options: any) => { spawns.push(options); return "%dup"; }, findRecoveryPane: () => undefined } as any });
    expect(outcomes).toEqual([expect.objectContaining({ name: "peer", status: "alive" })]);
    expect(spawns).toEqual([]);
    // The new extension instance in the same process re-claims its own lease.
    const reloaded = make(peerIdentity); await reloaded.emit("session_start", { reason: "reload" }); await drain();
    const after = (await runtime.readRuntimeStatus(team, "peer"))!;
    expect(after.reloading).toBeUndefined();
    expect(after.activity).toBe("idle");
  }, 10_000);

  it("a lead reload skips pane restoration; a real startup still runs it", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start", { reason: "startup" });
    // No tmux in this fixture, so an attempted restoration reports a blocked peer.
    expect(lead.ctx.ui.notify.mock.calls.flat().join("\n")).toContain("requires tmux");
    await lead.emit("session_shutdown", { reason: "reload" });
    const reloaded = make(leadIdentity); await reloaded.emit("session_start", { reason: "reload" }); await drain();
    expect(reloaded.ctx.ui.notify.mock.calls.flat().join("\n")).not.toContain("requires tmux");
    expect((await runtime.readRuntimeStatus(team, "team-lead"))?.instanceId).toBeDefined();
  }, 10_000);

  it("reloading an interrupted peer admits no quiescence inspection and keeps it paused and live", async () => {
    const lead = make(leadIdentity); await lead.emit("session_start");
    const peer = make(peerIdentity); await peer.emit("session_start"); await peer.emit("agent_start");
    await peer.emit("agent_settled", { aborted: true }); await drain();
    await openFormalGeneration(team);
    await peer.emit("session_shutdown", { reason: "reload" });
    const status = (await runtime.readRuntimeStatus(team, "peer"))!;
    expect(status).toMatchObject({ activity: "interrupted", paused: true, reloading: true });
    expect(status.detached).toBeFalsy();
    expect((await readQuiescenceState(team)).inspection).toBeUndefined();
    expect(await messaging.readInbox(team, "team-lead", true, false)).toEqual([]);
  }, 10_000);

  it("same-process re-claim requires the exact PID, start token, and conversation", async () => {
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await peer.emit("session_shutdown", { reason: "reload" });
    const previous = (await runtime.readRuntimeStatus(team, "peer"))!;
    await expect(claimSession({ team, agent: "peer", identity: peerIdentity, instanceId: "other",
      pid: previous.pid! + 1, processStartToken: previous.processStartToken, sameProcessReload: true, alive: () => true }))
      .rejects.toThrow("another live process owns this member");
    await expect(claimSession({ team, agent: "peer", identity: peerIdentity, instanceId: "other",
      pid: previous.pid!, processStartToken: "different-start", sameProcessReload: true, alive: () => true }))
      .rejects.toThrow("another live process owns this member");
    await expect(claimSession({ team, agent: "peer", identity: peerIdentity, instanceId: "other",
      pid: previous.pid!, processStartToken: previous.processStartToken, alive: () => true }))
      .rejects.toThrow("another live process owns this member");
  }, 10_000);

  it("on a host without process start tokens a reload still re-claims instead of stranding the member (N1)", async () => {
    vi.spyOn(runtime, "getProcessStartToken").mockReturnValue(undefined);
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await peer.emit("session_shutdown", { reason: "reload" });
    const before = (await runtime.readRuntimeStatus(team, "peer"))!;
    expect(before.processStartToken).toBeUndefined();
    expect(before.reloading).toBe(true);
    const reloaded = make(peerIdentity); await reloaded.emit("session_start", { reason: "reload" }); await drain();
    expect(reloaded.ctx.ui.notify.mock.calls.flat().join("\n")).not.toContain("Team recovery blocked");
    const after = (await runtime.readRuntimeStatus(team, "peer"))!;
    expect(after.reloading).toBeUndefined();
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.activity).toBe("idle");
  }, 10_000);

  it("a tokenless re-claim requires the reloading marker and the same conversation (N1)", async () => {
    vi.spyOn(runtime, "getProcessStartToken").mockReturnValue(undefined);
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await peer.emit("session_shutdown", { reason: "reload" });
    const previous = (await runtime.readRuntimeStatus(team, "peer"))!;
    expect(previous.processStartToken).toBeUndefined();
    // Same live PID, same conversation, reloading marker: the re-claim is allowed.
    const reclaimed = await claimSession({ team, agent: "peer", identity: peerIdentity, instanceId: "next",
      pid: previous.pid!, processStartToken: undefined, sameProcessReload: true, alive: () => true });
    expect(reclaimed.reloading).toBeUndefined();
    // The marker is gone: a further tokenless claim at the same PID is rejected.
    await expect(claimSession({ team, agent: "peer", identity: peerIdentity, instanceId: "third",
      pid: previous.pid!, processStartToken: undefined, sameProcessReload: true, alive: () => true }))
      .rejects.toThrow("another live process owns this member");
    // A different conversation at the same PID never reaches the process check.
    await expect(claimSession({ team, agent: "peer", identity: { id: "other", file: "/no/such/file.json", cwd: root, confirmed: true },
      instanceId: "fourth", pid: previous.pid!, processStartToken: undefined, sameProcessReload: true, alive: () => true }))
      .rejects.toThrow("no exact saved Pi session mapping");
  }, 10_000);

  it("only the lead can request a team reload", async () => {
    const peer = make(peerIdentity); await peer.emit("session_start"); await drain();
    await expect(peer.commands.get("team-reload").handler("", peer.ctx)).rejects.toThrow("Only the team lead");
  });
});
