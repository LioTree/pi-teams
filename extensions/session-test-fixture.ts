import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Enrich pre-recovery regression fixtures with the session API actual Pi supplies. */
export function fixtureSession(root: string, team: string, agent: string): SessionManager {
  const dir = path.join(root, "fixture-sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agent}.jsonl`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({
    type: "session", version: 3, id: `fixture-${agent}`, cwd: root,
    timestamp: new Date(0).toISOString(),
  }) + "\n");
  const configFile = path.join(root, "teams", team, "config.json");
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    let member = config.members.find((item: { name: string }) => item.name === agent);
    if (!member) {
      member = { name: agent, agentId: `${agent}@${team}`, agentType: agent === "team-lead" ? "lead" : "teammate",
        cwd: root, joinedAt: 1, tmuxPaneId: "", subscriptions: [] };
      config.members.push(member);
    }
    member.session = { id: `fixture-${agent}`, file, cwd: root, confirmed: true };
    fs.writeFileSync(configFile, JSON.stringify(config));
  }
  return SessionManager.open(file, dir);
}
