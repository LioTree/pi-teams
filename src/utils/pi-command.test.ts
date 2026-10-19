import { describe, expect, it } from "vitest";
import { buildPiCommand, getPiLaunchCommand, getProjectTrustArg, shellArgument } from "./pi-command";

describe("Pi launch command", () => {
  it("reuses the exact Node binary and CLI script on Nix/WSL", () => {
    expect(getPiLaunchCommand("/home/user/pi/dist/cli.js", "/nix/store/node/bin/node", "linux"))
      .toBe("'/nix/store/node/bin/node' '/home/user/pi/dist/cli.js'");
  });

  it("quotes POSIX paths containing spaces, apostrophes and dollar signs", () => {
    expect(getPiLaunchCommand("/tmp/it's $pi/cli.js", "/opt/node runtime/node", "linux"))
      .toBe("'/opt/node runtime/node' '/tmp/it'\\''s $pi/cli.js'");
  });

  it("uses PowerShell's call operator and literal Windows path quoting", () => {
    expect(getPiLaunchCommand("C:\\O'Brien\\pi\\cli.js", "C:\\Program Files\\nodejs\\node.exe", "win32"))
      .toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\O''Brien\\pi\\cli.js'");
  });

  it.each(["linux", "win32"] as const)("supports standalone binaries on %s", platform => {
    const binary = platform === "win32" ? "C:\\Program Files\\pi.exe" : "/opt/pi binary";
    expect(getPiLaunchCommand("/$bunfs/root/pi", binary, platform))
      .toBe(`${platform === "win32" ? "& " : ""}'${binary}'`);
  });

  it.each(["/usr/bin/node", "/usr/bin/bun"])("falls back to PATH for %s shim installs", binary => {
    expect(getPiLaunchCommand("/volta/bin/pi", binary, "linux")).toBe("pi");
  });
});

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
