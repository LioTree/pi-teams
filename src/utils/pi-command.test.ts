import { describe, expect, it } from "vitest";
import { buildPiCommand, getProjectTrustArg } from "./pi-command";

describe("Pi teammate command", () => {
  it("inherits the lead's approve override", () => {
    expect(getProjectTrustArg(["node", "cli.js", "--approve"])).toBe("--approve");
    expect(getProjectTrustArg(["node", "cli.js", "-a"])).toBe("--approve");
    expect(buildPiCommand("pi", "provider/model", "high", "--approve"))
      .toBe("pi --approve --model provider/model:high");
  });

  it("inherits the lead's no-approve override", () => {
    expect(getProjectTrustArg(["node", "cli.js", "--no-approve"])).toBe("--no-approve");
    expect(getProjectTrustArg(["node", "cli.js", "-na"])).toBe("--no-approve");
  });

  it("does not add a trust override when the lead has none", () => {
    expect(getProjectTrustArg(["node", "cli.js"])).toBeUndefined();
    expect(buildPiCommand("pi", undefined, "medium", undefined))
      .toBe("pi --thinking medium");
  });
});
