import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "./models";

/**
 * Subset of ~/.pi/agent/settings.json fields used by pi-teams.
 *
 * Leader defaults (defaultProvider / defaultModel / defaultThinkingLevel) are
 * applied by Pi itself when a process is launched without --model/--thinking.
 *
 * Teammate defaults are applied by pi-teams when spawn/delegate do not pass an
 * explicit model/thinking. A team defaultModel takes precedence over only the
 * teammate model default; thinking resolution is independent of defaultModel.
 */
export interface AgentSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  /** Optional provider for teammates when teammateDefaultModel has no "provider/" prefix. */
  teammateDefaultProvider?: string;
  /**
   * Default model for teammates when tool calls omit `model` and the team has
   * no `defaultModel`. Accepts `provider/model` or a bare model id.
   */
  teammateDefaultModel?: string;
  /** Default thinking level for teammates when tool calls omit `thinking`. */
  teammateDefaultThinkingLevel?: string;
}

export function agentSettingsPath(homeDir?: string): string {
  const agentDir = homeDir
    ? path.join(homeDir, ".pi", "agent")
    : getAgentDir();
  return path.join(agentDir, "settings.json");
}

export function loadAgentSettings(
  settingsFile: string = agentSettingsPath(),
): AgentSettings {
  try {
    if (!fs.existsSync(settingsFile)) return {};
    const raw = fs.readFileSync(settingsFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as AgentSettings;
  } catch {
    return {};
  }
}

/**
 * Compose teammateDefaultProvider + teammateDefaultModel into a model string.
 * Returns undefined when teammateDefaultModel is unset/empty.
 */
export function resolveTeammateDefaultModelFromSettings(
  settings: AgentSettings,
): string | undefined {
  const model = typeof settings.teammateDefaultModel === "string"
    ? settings.teammateDefaultModel.trim()
    : "";
  if (!model) return undefined;
  if (model.includes("/")) return model;
  const provider = typeof settings.teammateDefaultProvider === "string"
    ? settings.teammateDefaultProvider.trim()
    : "";
  return provider ? `${provider}/${model}` : model;
}

export function resolveTeammateDefaultThinkingFromSettings(
  settings: AgentSettings,
): ThinkingLevel | undefined {
  const thinking = typeof settings.teammateDefaultThinkingLevel === "string"
    ? settings.teammateDefaultThinkingLevel.trim()
    : "";
  return THINKING_LEVELS.includes(thinking as ThinkingLevel)
    ? thinking as ThinkingLevel
    : undefined;
}

/**
 * Model resolution for teammate spawn:
 * explicit tool model → team.defaultModel → settings.teammateDefault* → undefined
 */
export function resolveTeammateModel(options: {
  explicitModel?: string;
  teamDefaultModel?: string;
  settings?: AgentSettings;
}): string | undefined {
  const explicit = options.explicitModel?.trim();
  if (explicit) return explicit;
  const teamDefault = options.teamDefaultModel?.trim();
  if (teamDefault) return teamDefault;
  return resolveTeammateDefaultModelFromSettings(options.settings ?? {});
}

/**
 * Thinking resolution for teammate spawn:
 * explicit tool thinking → settings.teammateDefaultThinkingLevel → undefined
 */
export function resolveTeammateThinking(options: {
  explicitThinking?: string;
  settings?: AgentSettings;
}): ThinkingLevel | undefined {
  const explicit = options.explicitThinking?.trim();
  if (THINKING_LEVELS.includes(explicit as ThinkingLevel)) {
    return explicit as ThinkingLevel;
  }
  return resolveTeammateDefaultThinkingFromSettings(options.settings ?? {});
}
