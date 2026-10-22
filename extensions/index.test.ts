import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, TeamConfig } from "../src/utils/models";
import extension from "./index";

const mocks = vi.hoisted(() => ({
  getTerminalAdapter: vi.fn(),
  getProcessStartToken: vi.fn(),
  readConfig: vi.fn(),
  updateRuntimeStatusForInstance: vi.fn(),
  readRuntimeStatus: vi.fn(),
  replaceRuntimeInstance: vi.fn(),
  isRuntimeProcessAlive: vi.fn(),
  hasConfirmedProcessIdentity: vi.fn(),
  removeMember: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: mocks.getTerminalAdapter,
}));

vi.mock("../src/utils/teams", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/teams")>(),
  readConfig: mocks.readConfig,
  removeMember: mocks.removeMember,
}));

vi.mock("../src/utils/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/runtime")>(),
  getProcessStartToken: mocks.getProcessStartToken,
  updateRuntimeStatusForInstance: mocks.updateRuntimeStatusForInstance,
  readRuntimeStatus: mocks.readRuntimeStatus,
  replaceRuntimeInstance: mocks.replaceRuntimeInstance,
  isRuntimeProcessAlive: mocks.isRuntimeProcessAlive,
  hasConfirmedProcessIdentity: mocks.hasConfirmedProcessIdentity,
}));

// No-team lead discovery must never scan the user's real ~/.pi/teams directory.
// Mock both import styles, including shutdown PID-file access in tool tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    unlinkSync: mocks.unlinkSync,
    rmSync: mocks.rmSync,
    default: { ...actual, existsSync: mocks.existsSync, readFileSync: mocks.readFileSync, unlinkSync: mocks.unlinkSync, rmSync: mocks.rmSync },
  };
});

type BeforeAgentStartHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
type LegacyBeforeAgentStartEvent = Pick<BeforeAgentStartEvent, "type" | "prompt" | "systemPrompt">;

const teamName = "prompt-regression-team";
const teammateName = "prompt-specialist";
const baseMember: Member = {
  agentId: `${teammateName}@${teamName}`,
  name: teammateName,
  agentType: "teammate",
  joinedAt: 1,
  tmuxPaneId: "",
  cwd: "/test-repo",
  subscriptions: [],
  model: "test/model-first",
  thinking: "high",
};

function teamConfig(member: Member = baseMember): TeamConfig {
  return {
    name: teamName,
    description: "In-memory prompt regression fixture",
    createdAt: 1,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: "test-session",
    members: [member],
  };
}

function registerExtension() {
  const handlers = new Map<string, unknown[]>();
  const registerTool = vi.fn();
  const api = {
    on: vi.fn((name: string, handler: unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return vi.fn();
    }),
    registerTool,
    registerCommand: vi.fn(),
  };

  // The real factory registers everything; the stub only records registrations.
  extension(api as unknown as ExtensionAPI);
  const registered = handlers.get("before_agent_start") ?? [];
  expect(registered).toHaveLength(1);
  expect(registerTool.mock.calls.some(([tool]) => tool.name === "team_create")).toBe(true);
  expect(mocks.getTerminalAdapter).toHaveBeenCalledOnce();
  const handler = registered[0] as BeforeAgentStartHandler;

  return async (event: BeforeAgentStartEvent | LegacyBeforeAgentStartEvent) => {
    // Deliberately exercise older hosts whose event lacks systemPromptOptions.
    // No session_start/shutdown, inbox polling, or registered tool is invoked.
    return handler(event as BeforeAgentStartEvent, {} as ExtensionContext);
  };
}

function modernEvent(turn: number): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: `Independent user prompt ${turn}`,
    systemPrompt: `Rendered base system prompt ${turn}`,
    systemPromptOptions: {
      cwd: "/test-repo",
      customPrompt: `Base system prompt ${turn}`,
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      contextFiles: [],
      skills: [],
      sections: {
        magic_context: `Magic Context supplied for turn ${turn}`,
        other_extension: `Other extension context for turn ${turn}`,
      },
    },
  };
}

function expectModernRole(
  event: BeforeAgentStartEvent,
  result: BeforeAgentStartEventResult | void,
  roleLine: string,
): string {
  const section = event.systemPromptOptions.sections.pi_teams;
  expect(section).toContain(roleLine);
  expect(section.split(roleLine)).toHaveLength(2);
  expect(section).not.toContain(event.systemPrompt);
  expect(section).not.toContain(event.systemPromptOptions.sections.magic_context);
  expect(result).toBeUndefined();
  expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();
  return section;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", "team-lead");
  // The factory consumes this variable; prevent any inherited handoff token loss.
  vi.stubEnv("PI_TEAM_HANDOFF_TOKEN", undefined);
  mocks.getTerminalAdapter.mockReturnValue(null);
  mocks.getProcessStartToken.mockReturnValue("test-process-start-token");
  mocks.existsSync.mockReturnValue(false);
  mocks.readConfig.mockResolvedValue(teamConfig());
  mocks.updateRuntimeStatusForInstance.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registered close and resume tools", () => {
  it("exposes reversible close and resume instead of destructive shutdown tools", () => {
    const registerTool = vi.fn();
    extension({ on: vi.fn(), registerTool, registerCommand: vi.fn() } as unknown as ExtensionAPI);
    const names = registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toContain("team_close");
    expect(names).toContain("team_resume");
    expect(names).not.toContain("process_shutdown_approved");
    expect(names).not.toContain("team_shutdown");
  });
});

describe("registered teammate default guidance", () => {
  function registeredTools() {
    const registerTool = vi.fn();
    extension({ on: vi.fn(), registerTool, registerCommand: vi.fn() } as unknown as ExtensionAPI);
    return new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
  }

  it.each(["team_create", "delegate_task", "create_predefined_team"])("documents omission and user-requested overrides on %s", (name) => {
    const tool = registeredTools().get(name);
    expect(tool.description).toMatch(/[Oo]mit/);
    expect(tool.description).toContain("configured teammate defaults");
    expect(tool.description).toContain("user explicitly requests");
    expect(tool.description).toContain("task difficulty");
  });

  it("explains both delegate overrides without hiding them or making them required", () => {
    const tool = registeredTools().get("delegate_task");
    for (const name of ["model", "thinking"]) {
      const parameter = tool.parameters.properties[name];
      expect(parameter.description).toContain("Omit to use");
      expect(parameter.description).toContain("user explicitly requests");
      expect(parameter.description).toContain("not based on task difficulty");
      expect(parameter.description).toContain("Does not change a live reused teammate");
      expect(tool.parameters.required).not.toContain(name);
    }
    expect(tool.parameters.properties.model.description).toContain("team defaultModel");
    expect(tool.parameters.properties.model.description).toContain("teammateDefaultModel");
    expect(tool.parameters.properties.thinking.description).toContain("teammateDefaultThinkingLevel");
  });

  it.each(["team_create", "create_predefined_team"])("does not leave %s default_model as an undocumented bypass", (name) => {
    const tool = registeredTools().get(name);
    const parameter = tool.parameters.properties.default_model;
    expect(parameter.description).toContain("Omit to");
    expect(parameter.description).toContain("user explicitly requests");
    expect(parameter.description).toContain("not based on task difficulty");
    expect(tool.parameters.required).not.toContain("default_model");
  });
});

describe("before_agent_start registered by the extension factory", () => {
  it.each([
    ["team-lead", "You are the pi-teams lead for this main Pi conversation."],
    [teammateName, `You are teammate '${teammateName}' working with the original main Pi conversation.`],
  ])("refreshes %s guidance on two independent modern runs without masking other sections", async (agentName, roleLine) => {
    vi.stubEnv("PI_AGENT_NAME", agentName);
    const run = registerExtension();
    const first = modernEvent(1);
    const second = modernEvent(2);
    expect(second.systemPromptOptions.sections).not.toBe(first.systemPromptOptions.sections);

    for (const event of [first, second]) {
      const originalSections = { ...event.systemPromptOptions.sections };
      const originalBase = event.systemPrompt;
      const result = await run(event);

      const section = expectModernRole(event, result, roleLine);
      if (agentName === "team-lead") {
        expect(section).toContain("Omit model, thinking, and default_model");
        expect(section).toContain("unless the user explicitly requests the corresponding override");
      }
      expect(event.systemPromptOptions.sections).toEqual({
        ...originalSections,
        pi_teams: expect.any(String),
      });
      expect(event.systemPrompt).toBe(originalBase);
    }
    expect(second.systemPromptOptions.sections.pi_teams).toBe(first.systemPromptOptions.sections.pi_teams);
  });

  it("reloads teammate model/thinking metadata and replaces an existing pi_teams section", async () => {
    vi.stubEnv("PI_AGENT_NAME", teammateName);
    const updatedMember: Member = { ...baseMember, model: "test/model-second", thinking: "minimal" };
    mocks.readConfig
      .mockResolvedValueOnce(teamConfig())
      .mockResolvedValueOnce(teamConfig(updatedMember))
      .mockResolvedValueOnce(teamConfig(updatedMember));
    const run = registerExtension();
    const roleLine = `You are teammate '${teammateName}' working with the original main Pi conversation.`;
    const first = modernEvent(1);
    const firstSection = expectModernRole(first, await run(first), roleLine);
    expect(firstSection).toContain("model: test/model-first with thinking level: high.");

    const second = modernEvent(2);
    second.systemPromptOptions.sections.pi_teams = firstSection;
    const secondSection = expectModernRole(second, await run(second), roleLine);
    expect(secondSection).toContain("model: test/model-second with thinking level: minimal.");
    expect(secondSection).not.toContain("test/model-first");
    expect(secondSection).not.toContain("thinking level: high");
    expect(second.systemPromptOptions.sections.magic_context).toBe("Magic Context supplied for turn 2");
    expect(second.systemPromptOptions.sections.other_extension).toBe("Other extension context for turn 2");
    expect(first.systemPromptOptions.sections.pi_teams).toBe(firstSection);

    // Re-dispatching an already-populated event is also replacement, not append.
    expectModernRole(second, await run(second), roleLine);
    expect(second.systemPromptOptions.sections.pi_teams).toBe(secondSection);
    expect(mocks.readConfig).toHaveBeenCalledTimes(3);
    expect(mocks.readConfig.mock.calls).toEqual([[teamName], [teamName], [teamName]]);
    expect(mocks.updateRuntimeStatusForInstance).toHaveBeenCalledTimes(3);
  });

  it("keeps implicit collaboration guidance on successive modern runs without scanning HOME", async () => {
    vi.stubEnv("PI_TEAM_NAME", undefined);
    vi.stubEnv("PI_AGENT_NAME", undefined);
    const run = registerExtension();

    for (const turn of [1, 2]) {
      const event = modernEvent(turn);
      const section = expectModernRole(event, await run(event), "You are the pi-teams lead for this main Pi conversation.");
      expect(section).toContain("Omit team_name everywhere");
      expect(section).not.toContain("Create a team with team_create");
      expect(section).toContain("Omit model, thinking, and default_model");
      expect(event.systemPromptOptions.sections.magic_context).toBe(`Magic Context supplied for turn ${turn}`);
    }
    // Identity lookup belongs to session_start, not factory/PID discovery.
    expect(mocks.existsSync).not.toHaveBeenCalled();
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.updateRuntimeStatusForInstance).not.toHaveBeenCalled();
  });

  it.each([
    ["team-lead", "You are the pi-teams lead for this main Pi conversation."],
    [teammateName, `You are teammate '${teammateName}' working with the original main Pi conversation.`],
  ])("preserves both independent legacy base prompts and appends %s guidance on each run", async (agentName, roleLine) => {
    vi.stubEnv("PI_AGENT_NAME", agentName);
    const run = registerExtension();

    for (const turn of [1, 2]) {
      const base = `Legacy base system prompt ${turn}\nExisting legacy context ${turn}`;
      const event: LegacyBeforeAgentStartEvent = {
        type: "before_agent_start",
        prompt: `Independent legacy user prompt ${turn}`,
        systemPrompt: base,
      };
      const result = await run(event);
      expect(result?.systemPrompt?.startsWith(base)).toBe(true);
      expect(result?.systemPrompt).toContain(roleLine);
      if (agentName === "team-lead") {
        expect(result?.systemPrompt).toContain("Omit model, thinking, and default_model");
        expect(result?.systemPrompt).toContain("unless the user explicitly requests the corresponding override");
      }
      expect(result?.systemPrompt?.split(roleLine)).toHaveLength(2);
      expect(result?.systemPrompt?.split(base)).toHaveLength(2);
      expect(event.systemPrompt).toBe(base);
    }
  });

  it("retains teammate role on both modern runs when reading team config fails", async () => {
    vi.stubEnv("PI_AGENT_NAME", teammateName);
    mocks.readConfig.mockRejectedValue(new Error("Simulated unavailable team config"));
    const run = registerExtension();
    const roleLine = `You are teammate '${teammateName}' working with the original main Pi conversation.`;

    for (const turn of [1, 2]) {
      const event = modernEvent(turn);
      const section = expectModernRole(event, await run(event), roleLine);
      expect(section).toContain("Your lead is 'team-lead'.");
      expect(section).not.toContain("You are currently using model:");
      expect(event.systemPromptOptions.sections.magic_context).toBe(`Magic Context supplied for turn ${turn}`);
    }
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });

  it("retains teammate role and the legacy base prompt when reading team config fails", async () => {
    vi.stubEnv("PI_AGENT_NAME", teammateName);
    mocks.readConfig.mockRejectedValue(new Error("Simulated unavailable team config"));
    const run = registerExtension();

    for (const turn of [1, 2]) {
      const base = `Legacy base after config failure ${turn}`;
      const result = await run({ type: "before_agent_start", prompt: "Continue", systemPrompt: base });
      expect(result?.systemPrompt?.startsWith(base)).toBe(true);
      expect(result?.systemPrompt).toContain(`You are teammate '${teammateName}' working with the original main Pi conversation.`);
      expect(result?.systemPrompt).not.toContain("You are currently using model:");
    }
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });
});
