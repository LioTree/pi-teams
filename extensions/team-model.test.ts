import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import { allocateSession } from "../src/utils/team-session";
import { readQuiescenceState } from "../src/utils/quiescence";
import { parseModelRef, readModelChangeResult } from "../src/utils/team-model";
import type { TeamSession } from "../src/utils/models";

vi.mock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => null }));
let root: string;
let leadIdentity: TeamSession;
let peerIdentity: TeamSession;
const team = "model-team";
const loaded: any[] = [];

function make(identity: TeamSession, options?: { setModel?: (model: unknown) => Promise<boolean> }) {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: string[] = [];
  let idle = true;
  const setModel = options?.setModel ?? vi.fn(async () => true);
  const setThinkingLevel = vi.fn();
  const ctx: any = {
    sessionManager: SessionManager.open(identity.file),
    isIdle: () => idle,
    cwd: root,
    modelRegistry: {
      find: (provider: string, id: string) => id === "missing" ? undefined : { provider, id },
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
  };
  extension({
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (text: string) => sent.push(text),
    setModel,
    setThinkingLevel,
  } as any);
  const object = {
    handlers, tools, commands, sent, ctx, setModel, setThinkingLevel,
    setIdle: (value: boolean) => { idle = value; },
    emit: (name: string, event: any = {}) => handlers.get(name)({ type: name, ...event }, ctx),
  };
  loaded.push(object);
  return object;
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const nextPoll = () => new Promise(resolve => setTimeout(resolve, 1100));

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-model-"));
  vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  vi.spyOn(paths, "teamDir").mockImplementation(name => path.join(root, "teams", name));
  vi.spyOn(paths, "taskDir").mockImplementation(name => path.join(root, "tasks", name));
  vi.spyOn(paths, "configPath").mockImplementation(name => path.join(root, "teams", name, "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((name, agent) => path.join(root, "teams", name, "runtime", `${agent}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((name, agent) => path.join(root, "teams", name, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "leadSessionPath").mockImplementation(name => path.join(root, "teams", name, "lead-session.json"));
  vi.spyOn(paths, "listTeamNames").mockReturnValue([team]);
  vi.stubEnv("PI_TEAM_NAME", undefined);
  vi.stubEnv("PI_AGENT_NAME", undefined);
  vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", undefined);
  await teams.createTeam(team, "legacy", "lead");
  leadIdentity = allocateSession(team, root);
  peerIdentity = allocateSession(team, root);
  await teams.updateMember(team, "team-lead", { session: leadIdentity });
  await teams.addMember(team, {
    name: "peer", agentId: "peer@model", agentType: "teammate", joinedAt: 1,
    tmuxPaneId: "%peer", cwd: root, subscriptions: [], session: { ...peerIdentity, confirmed: true },
  });
});
afterEach(async () => {
  for (const target of loaded.splice(0)) await target.emit("session_shutdown").catch(() => {});
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lead-directed teammate model change", () => {
  it("parses provider/id and rejects a bare id", () => {
    expect(parseModelRef("xai/grok-4.7")).toEqual({ provider: "xai", id: "grok-4.7" });
    expect(parseModelRef("grok-4.7")).toBeUndefined();
  });

  it("the teammate extension applies the model without sending it to that model", async () => {
    const lead = make(leadIdentity);
    const peer = make(peerIdentity);
    await lead.emit("session_start", { reason: "startup" });
    await peer.emit("session_start", { reason: "startup" });
    await drain();
    peer.setIdle(false);
    const before = await readQuiescenceState(team);
    await lead.commands.get("team-model").handler("peer xai/grok-4.7 xhigh", lead.ctx);
    await nextPoll();
    await drain();
    expect(peer.setModel).toHaveBeenCalledWith({ provider: "xai", id: "grok-4.7" });
    expect(peer.setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(peer.sent.join("\n")).not.toContain("grok-4.7");
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")).toMatchObject({
      model: "xai/grok-4.7", thinking: "xhigh",
    });
    expect(readModelChangeResult(team, "peer")).toMatchObject({ ok: true });
    expect((await readQuiescenceState(team)).generation).toBe(before.generation);
    expect(peer.setModel).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("keeps an interrupted teammate paused and does not claim a missing provider login", async () => {
    const lead = make(leadIdentity);
    const peer = make(peerIdentity, { setModel: vi.fn(async () => false) });
    await lead.emit("session_start");
    await peer.emit("session_start");
    await peer.emit("agent_start");
    await peer.emit("agent_settled", { aborted: true });
    await drain();
    await lead.commands.get("team-model").handler("peer openai/gpt-6.1-sol", lead.ctx);
    await nextPoll();
    await drain();
    expect(peer.setModel).toHaveBeenCalledTimes(1);
    expect(await runtime.readRuntimeStatus(team, "peer")).toMatchObject({ activity: "interrupted", paused: true });
    expect(readModelChangeResult(team, "peer")).toMatchObject({ ok: false, error: "no authentication for this provider" });
    expect((await teams.readConfig(team)).members.find(member => member.name === "peer")?.model).toBeUndefined();
    await lead.commands.get("team-model").handler("status", lead.ctx);
    expect(lead.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("refused");
  }, 10_000);

  it("a teammate cannot change models", async () => {
    const peer = make(peerIdentity);
    await peer.emit("session_start");
    await drain();
    await expect(peer.commands.get("team-model").handler("peer xai/grok-4.7", peer.ctx))
      .rejects.toThrow("Only the team lead can change a teammate model");
    expect(peer.setModel).not.toHaveBeenCalled();
  }, 10_000);
});
