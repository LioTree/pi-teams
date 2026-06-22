import { describe, it, expect } from "vitest";
import { teamDir, inboxPath, sanitizeName } from "./paths";

describe("Security Audit - Path Traversal (Prevention Check)", () => {
  it("should throw an error for path traversal via teamName", () => {
    const maliciousTeamName = "../../etc";
    expect(() => teamDir(maliciousTeamName)).toThrow();
  });

  it("should throw an error for path traversal via agentName", () => {
    const teamName = "audit-team";
    const maliciousAgentName = "../../../.ssh/id_rsa";
    expect(() => inboxPath(teamName, maliciousAgentName)).toThrow();
  });

  it("should throw an error for path traversal via taskId", () => {
    const teamName = "audit-team";
    const maliciousTaskId = "../../../etc/passwd";
    // We need to import readTask/updateTask or just sanitizeName directly if we want to test the logic
    // But since we already tested sanitizeName via other paths, this is just for completeness.
    expect(() => sanitizeName(maliciousTaskId)).toThrow();
  });
});
