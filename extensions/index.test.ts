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
  existsSync: vi.fn(),
}));

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: mocks.getTerminalAdapter,
}));

vi.mock("../src/utils/teams", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/teams")>(),
  readConfig: mocks.readConfig,
}));

vi.mock("../src/utils/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/runtime")>(),
  getProcessStartToken: mocks.getProcessStartToken,
  updateRuntimeStatusForInstance: mocks.updateRuntimeStatusForInstance,
}));

// No-team lead discovery must never scan the user's real ~/.pi/teams directory.
// Mock both import styles; no lifecycle handlers or tool executors run here.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    default: { ...actual, existsSync: mocks.existsSync },
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

describe("before_agent_start registered by the extension factory", () => {
  it.each([
    ["team-lead", `You are the team lead for team '${teamName}'.`],
    [teammateName, `You are teammate '${teammateName}' on team '${teamName}'.`],
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

      expectModernRole(event, result, roleLine);
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
    const roleLine = `You are teammate '${teammateName}' on team '${teamName}'.`;
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

  it("keeps create-team guidance on successive modern runs for an unbound lead without scanning HOME", async () => {
    vi.stubEnv("PI_TEAM_NAME", undefined);
    vi.stubEnv("PI_AGENT_NAME", undefined);
    const run = registerExtension();

    for (const turn of [1, 2]) {
      const event = modernEvent(turn);
      const section = expectModernRole(event, await run(event), "You are the pi-teams team lead.");
      expect(section).toContain("Create a team with team_create");
      expect(event.systemPromptOptions.sections.magic_context).toBe(`Magic Context supplied for turn ${turn}`);
    }
    expect(mocks.existsSync).toHaveBeenCalled();
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.updateRuntimeStatusForInstance).not.toHaveBeenCalled();
  });

  it.each([
    ["team-lead", `You are the team lead for team '${teamName}'.`],
    [teammateName, `You are teammate '${teammateName}' on team '${teamName}'.`],
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
      expect(result?.systemPrompt?.split(roleLine)).toHaveLength(2);
      expect(result?.systemPrompt?.split(base)).toHaveLength(2);
      expect(event.systemPrompt).toBe(base);
    }
  });

  it("retains teammate role on both modern runs when reading team config fails", async () => {
    vi.stubEnv("PI_AGENT_NAME", teammateName);
    mocks.readConfig.mockRejectedValue(new Error("Simulated unavailable team config"));
    const run = registerExtension();
    const roleLine = `You are teammate '${teammateName}' on team '${teamName}'.`;

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
      expect(result?.systemPrompt).toContain(`You are teammate '${teammateName}' on team '${teamName}'.`);
      expect(result?.systemPrompt).not.toContain("You are currently using model:");
    }
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });
});
