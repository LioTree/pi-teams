import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { TeamConfig, TeamSession } from "./models";
import type { SpawnOptions, TerminalAdapter } from "./terminal-adapter";
import { configPath, runtimeStatusPath } from "./paths";
import { readRuntimeStatusSync } from "./runtime";
import { withLock } from "./lock";
import { atomicWriteJsonSync } from "./atomic-file";
import { sameSession } from "./team-session";

/** Keep membership/reservation stable across initial launch, including partial failures. */
export async function launchReservedMember(input: {
  team: string; agent: string; session: TeamSession; ownerInstanceId: string;
  terminal: TerminalAdapter; options: SpawnOptions; separateWindow: boolean; current: () => boolean;
  authority?: { team: string; agent: string };
}): Promise<{ terminalId: string; isWindow: boolean }> {
  const file = configPath(input.team);
  return withLock(file, async () => {
    const launch = async () => {
      const authority = input.authority && readRuntimeStatusSync(input.authority.team, input.authority.agent);
      if (input.authority && (!authority || authority.instanceId !== input.ownerInstanceId || authority.detached || authority.activity === "stopped")) {
        throw new Error("launch authority was replaced or detached");
      }
      const config = JSON.parse(fs.readFileSync(file, "utf8")) as TeamConfig;
      const member = config.members.find(item => item.name === input.agent);
      if (!input.current() || !member || !sameSession(member.session, input.session)) throw new Error("member/session launch was superseded");
      if (member.recovery && member.recovery.phase !== "failed") throw new Error("member already has a launch reservation; do not start a duplicate");
      const token = randomUUID();
      member.recovery = { token, ownerInstanceId: input.ownerInstanceId, phase: "reserved" };
      atomicWriteJsonSync(file, config);
      let terminalId: string | undefined;
      try {
        const options = { ...input.options, recoveryToken: token,
          env: { ...input.options.env, PI_TEAM_RECOVERY_TOKEN: token } };
        terminalId = input.separateWindow ? input.terminal.spawnWindow(options) : input.terminal.spawn(options);
        if (input.separateWindow) member.windowId = terminalId;
        else member.tmuxPaneId = terminalId;
        member.recovery.phase = "launched";
        atomicWriteJsonSync(file, config);
        return { terminalId, isWindow: input.separateWindow };
      } catch (error) {
        const definiteNoLaunch = !terminalId && (error as { spawned?: boolean }).spawned === false;
        if (definiteNoLaunch) member.recovery.phase = "failed";
        member.recovery.error = error instanceof Error ? error.message : String(error);
        try { atomicWriteJsonSync(file, config); } catch { /* reservation already durable */ }
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!definiteNoLaunch) Object.assign(failure, { mayHaveLaunched: true, terminalId });
        throw failure;
      }
    };
    return input.authority ? withLock(runtimeStatusPath(input.authority.team, input.authority.agent), launch) : launch();
  });
}
