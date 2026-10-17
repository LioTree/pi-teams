import { describe, expect, it } from "vitest";
import { buildPiCommand, getProjectTrustArg, shellArgument } from "./pi-command";

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

  it("quotes session paths and model arguments without shell interpolation", () => {
    const file = "/tmp/project's $(touch BAD)/original session.jsonl";
    expect(buildPiCommand("pi", undefined, undefined, null, file))
      .toBe(`pi --session ${shellArgument(file)}`);
    expect(shellArgument("x'$(echo bad)")).toBe("'x'\\''$(echo bad)'");
    expect(buildPiCommand("pi", "provider/model name;echo BAD", "high", "--no-approve"))
      .toBe("pi --no-approve --model 'provider/model name;echo BAD:high'");
  });

  it("passes max thinking level through to pi", () => {
    expect(buildPiCommand("pi", "provider/model", "max"))
      .toBe("pi --model provider/model:max");
    expect(buildPiCommand("pi", undefined, "max", undefined))
      .toBe("pi --thinking max");
  });
});
