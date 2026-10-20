import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSettingsPath,
  loadAgentSettings,
  resolveTeammateDefaultModelFromSettings,
  resolveTeammateDefaultThinkingFromSettings,
  resolveTeammateModel,
  resolveTeammateThinking,
} from "./agent-settings";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-settings-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadAgentSettings", () => {
  it("returns empty object when file is missing", () => {
    const dir = tempDir();
    expect(loadAgentSettings(path.join(dir, "missing.json"))).toEqual({});
  });

  it("loads teammate default fields", () => {
    const dir = tempDir();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({
      defaultProvider: "grok-oauth",
      defaultModel: "grok-4.5",
      defaultThinkingLevel: "high",
      teammateDefaultProvider: "opencode-go",
      teammateDefaultModel: "deepseek-v4-flash",
      teammateDefaultThinkingLevel: "max",
    }));
    expect(loadAgentSettings(file)).toMatchObject({
      teammateDefaultProvider: "opencode-go",
      teammateDefaultModel: "deepseek-v4-flash",
      teammateDefaultThinkingLevel: "max",
    });
  });

  it("returns empty object on invalid JSON", () => {
    const dir = tempDir();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{not-json");
    expect(loadAgentSettings(file)).toEqual({});
  });

  it("uses ~/.pi/agent/settings.json path under a home dir", () => {
    expect(agentSettingsPath("/home/test")).toBe(
      path.join("/home/test", ".pi", "agent", "settings.json"),
    );
  });

  it("uses PI_CODING_AGENT_DIR for its default path", () => {
    const dir = tempDir();
    process.env.PI_CODING_AGENT_DIR = dir;
    expect(agentSettingsPath()).toBe(path.join(dir, "settings.json"));
  });

  it("loads settings from PI_CODING_AGENT_DIR by default", () => {
    const dir = tempDir();
    process.env.PI_CODING_AGENT_DIR = dir;
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      teammateDefaultThinkingLevel: "xhigh",
    }));
    expect(loadAgentSettings()).toMatchObject({
      teammateDefaultThinkingLevel: "xhigh",
    });
  });

  it("preserves Pi's tilde expansion for PI_CODING_AGENT_DIR", () => {
    process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";
    expect(agentSettingsPath()).toBe(
      path.join(os.homedir(), "custom-pi-agent", "settings.json"),
    );
  });
});

describe("resolveTeammateDefaultModelFromSettings", () => {
  it("returns provider/model when both set and model is bare", () => {
    expect(resolveTeammateDefaultModelFromSettings({
      teammateDefaultProvider: "opencode-go",
      teammateDefaultModel: "deepseek-v4-flash",
    })).toBe("opencode-go/deepseek-v4-flash");
  });

  it("keeps full provider/model strings as-is", () => {
    expect(resolveTeammateDefaultModelFromSettings({
      teammateDefaultProvider: "ignored",
      teammateDefaultModel: "grok-oauth/grok-4.5",
    })).toBe("grok-oauth/grok-4.5");
  });

  it("returns bare model when provider is absent", () => {
    expect(resolveTeammateDefaultModelFromSettings({
      teammateDefaultModel: "deepseek-v4-flash",
    })).toBe("deepseek-v4-flash");
  });

  it("returns undefined when model is empty", () => {
    expect(resolveTeammateDefaultModelFromSettings({})).toBeUndefined();
    expect(resolveTeammateDefaultModelFromSettings({
      teammateDefaultModel: "  ",
    })).toBeUndefined();
  });
});

describe("resolveTeammateModel priority", () => {
  const settings = {
    teammateDefaultProvider: "opencode-go",
    teammateDefaultModel: "deepseek-v4-flash",
  };

  it("prefers explicit model", () => {
    expect(resolveTeammateModel({
      explicitModel: "grok-oauth/grok-4.5",
      teamDefaultModel: "other/model",
      settings,
    })).toBe("grok-oauth/grok-4.5");
  });

  it("prefers team default over settings", () => {
    expect(resolveTeammateModel({
      teamDefaultModel: "team/default",
      settings,
    })).toBe("team/default");
  });

  it("falls back to settings teammate default", () => {
    expect(resolveTeammateModel({ settings })).toBe("opencode-go/deepseek-v4-flash");
  });

  it("returns undefined when nothing configured", () => {
    expect(resolveTeammateModel({})).toBeUndefined();
  });
});

describe("resolveTeammateThinking", () => {
  it("keeps max defaults when omitted while honoring a user-requested lower override", () => {
    const settings = { teammateDefaultThinkingLevel: "max" };
    expect(resolveTeammateThinking({ settings })).toBe("max");
    expect(resolveTeammateThinking({ settings, explicitThinking: "high" })).toBe("high");
  });

  it("prefers explicit thinking", () => {
    expect(resolveTeammateThinking({
      explicitThinking: "max",
      settings: { teammateDefaultThinkingLevel: "high" },
    })).toBe("max");
  });

  it("falls back to settings", () => {
    expect(resolveTeammateDefaultThinkingFromSettings({
      teammateDefaultThinkingLevel: "high",
    })).toBe("high");
    expect(resolveTeammateThinking({
      settings: { teammateDefaultThinkingLevel: "high" },
    })).toBe("high");
  });

  it("returns undefined when unset", () => {
    expect(resolveTeammateThinking({})).toBeUndefined();
  });

  it("ignores unsupported settings values", () => {
    expect(resolveTeammateDefaultThinkingFromSettings({
      teammateDefaultThinkingLevel: "hihg",
    })).toBeUndefined();
    expect(resolveTeammateThinking({
      settings: { teammateDefaultThinkingLevel: "turbo" },
    })).toBeUndefined();
  });

  it("ignores unsupported explicit values and falls back to settings", () => {
    expect(resolveTeammateThinking({
      explicitThinking: "hihg",
      settings: { teammateDefaultThinkingLevel: "medium" },
    })).toBe("medium");
    expect(resolveTeammateThinking({
      explicitThinking: "turbo",
    })).toBeUndefined();
  });

  it("ignores non-string settings values", () => {
    expect(resolveTeammateDefaultThinkingFromSettings({
      teammateDefaultThinkingLevel: 42,
    } as unknown as Parameters<typeof resolveTeammateDefaultThinkingFromSettings>[0]))
      .toBeUndefined();
  });

  it("trims and accepts every supported settings value", () => {
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(resolveTeammateDefaultThinkingFromSettings({
        teammateDefaultThinkingLevel: ` ${thinking} `,
      })).toBe(thinking);
    }
  });
});
