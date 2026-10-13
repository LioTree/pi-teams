import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../utils/terminal-adapter", () => ({ execCommand: vi.fn() }));

import { execCommand } from "../utils/terminal-adapter";
import { WindowsAdapter } from "./windows-adapter";
import { clearAdapterCache, getTerminalAdapter } from "./terminal-registry";

const mockExecCommand = vi.mocked(execCommand);
const execResult = (stdout = "", status: number | null = 0, stderr = "") => ({ stdout, stderr, status });
const originalPlatform = process.platform;
const originalExecPath = process.execPath;
const wtPath = "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
const wslWtPath = "/mnt/c/Users/test/AppData/Local/Microsoft/WindowsApps/wt.exe";
const options = {
  name: "worker",
  teamName: "team",
  cwd: "/project",
  command: "pi --model provider/model:high",
  env: { PI_TEAM_NAME: "team", PI_AGENT_NAME: "worker", PATH: "/test/bin" },
};

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function useWsl() {
  setPlatform("linux");
  vi.stubEnv("WT_SESSION", "parent-session");
  vi.stubEnv("WSL_DISTRO_NAME", "NixOS");
  vi.stubEnv("PATH", `${path.posix.dirname(wslWtPath)}:/test/bin`);
  Object.defineProperty(process, "execPath", { value: "/nix/store/test-node/bin/node", configurable: true });
}

function lastArgs(): string[] {
  return mockExecCommand.mock.calls.at(-1)![1];
}

function powershellScript(args = lastArgs()): string {
  return Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
}

function wslBootstrap(args = lastArgs()): string {
  return Buffer.from(args[args.indexOf("-e") + 2], "base64").toString("utf8");
}

describe("WindowsAdapter", () => {
  let adapter: WindowsAdapter;

  beforeEach(() => {
    adapter = new WindowsAdapter();
    clearAdapterCache();
    vi.resetAllMocks();
    for (const key of ["TMUX", "ZELLIJ", "WEZTERM_PANE", "CMUX_SOCKET_PATH", "CMUX_WORKSPACE_ID", "TERM_PROGRAM", "WT_SESSION", "WSL_DISTRO_NAME"]) {
      vi.stubEnv(key, undefined);
    }
    setPlatform("win32");
    vi.spyOn(os, "userInfo").mockReturnValue({ username: "test-user", uid: 1000, gid: 100, shell: "/bin/sh", homedir: "/home/test-user" });
    // Binary lookup must not scan any real user PATH directories in tests.
    vi.spyOn(fs, "accessSync").mockImplementation(candidate => {
      if ([wslWtPath, "/test/bin/node"].includes(candidate.toString())) return;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);
    mockExecCommand.mockImplementation((command) => {
      if (command === "where.exe") return execResult(`${wtPath}\r\n`);
      if (command === "pwsh" || command === "powershell") return execResult("found\n");
      return execResult();
    });
  });

  afterEach(() => {
    clearAdapterCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
  });

  describe("detection", () => {
    it("detects native Windows without launching wt to probe it", () => {
      expect(adapter.name).toBe("Windows");
      expect(adapter.detect()).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledExactlyOnceWith("where.exe", ["wt.exe"]);
      expect(adapter.supportsWindows()).toBe(true);
      expect(mockExecCommand).toHaveBeenCalledTimes(1);
    });

    it("detects WSL inside Windows Terminal", () => {
      useWsl();
      expect(adapter.detect()).toBe(true);
      expect(adapter.supportsWindows()).toBe(true);
      expect(fs.accessSync).toHaveBeenCalledExactlyOnceWith(wslWtPath, fs.constants.X_OK);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it("is selected by the real terminal registry in a WSL Terminal session", () => {
      useWsl();
      const terminal = getTerminalAdapter();
      expect(terminal).toBeInstanceOf(WindowsAdapter);
      expect(getTerminalAdapter()).toBe(terminal);
    });

    it.each(["WT_SESSION", "WSL_DISTRO_NAME"])("requires %s for Linux detection", key => {
      useWsl();
      vi.stubEnv(key, undefined);
      expect(adapter.detect()).toBe(false);
      expect(adapter.supportsWindows()).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it.each(["linux", "darwin"] as const)("does not detect ordinary %s", platform => {
      setPlatform(platform);
      expect(adapter.detect()).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it.each(["TMUX", "ZELLIJ", "WEZTERM_PANE", "CMUX_SOCKET_PATH", "CMUX_WORKSPACE_ID"])("preserves %s priority on native Windows and WSL", key => {
      vi.stubEnv(key, "present");
      expect(adapter.detect()).toBe(false);
      useWsl();
      expect(adapter.detect()).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it.each([null, 1, 0])("does not assume wt exists when resolution gives status %s and no path", status => {
      mockExecCommand.mockReturnValue(execResult("", status));
      expect(adapter.detect()).toBe(false);
      expect(adapter.supportsWindows()).toBe(false);
      expect(() => adapter.spawn(options)).toThrow("wt.exe");
    });

    it("skips missing PATH entries without starting a shell", () => {
      useWsl();
      vi.stubEnv("PATH", `/missing/bin:${path.posix.dirname(wslWtPath)}`);
      expect(adapter.detect()).toBe(true);
      expect(fs.accessSync).toHaveBeenCalledWith("/missing/bin/wt.exe", fs.constants.X_OK);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it("rejects a directory masquerading as wt.exe", () => {
      useWsl();
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof fs.statSync>);
      expect(adapter.detect()).toBe(false);
    });

    it("rejects WSL with Windows PATH integration unavailable", () => {
      useWsl();
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error("not executable"); });
      expect(adapter.detect()).toBe(false);
      expect(mockExecCommand).not.toHaveBeenCalled();
    });
  });

  describe("native Windows", () => {
    it("uses valid split-pane arguments and encoded PowerShell", () => {
      expect(adapter.spawn(options)).toMatch(/^windows_\d+_worker$/);
      expect(mockExecCommand.mock.calls.at(-1)![0]).toBe(wtPath);
      expect(lastArgs().slice(0, 11)).toEqual([
        "-w", "0", "split-pane", "--vertical", "--size", "0.5", "--title", "team: worker", "--suppressApplicationTitle", "--", "pwsh",
      ]);
      expect(lastArgs()).not.toContain("-NoExit");
      expect(lastArgs()).not.toContain("-Command");
      expect(powershellScript()).toContain("$env:PI_TEAM_NAME='team'; $env:PI_AGENT_NAME='worker'; pi");
      expect(powershellScript()).not.toContain("$env:PATH");
      expect(mockExecCommand.mock.calls.some(([, args]) => args.includes("list") || args.includes("--version"))).toBe(false);
    });

    it("escapes literal paths and values and excludes invalid/non-PI variables", () => {
      adapter.spawn({
        ...options,
        cwd: "C:\\O'Brien; $data",
        env: { PI_TEXT: "it's; $literal", "PI_BAD;key": "ignored", OTHER: "ignored" },
      });
      const script = powershellScript();
      expect(script).toContain("Set-Location -LiteralPath 'C:\\O''Brien; $data'");
      expect(script).toContain("$env:PI_TEXT='it''s; $literal'");
      expect(script).not.toContain("ignored");
      expect(lastArgs().every(arg => !arg.includes(";"))).toBe(true);
    });

    it("falls back to Windows PowerShell 5.1", () => {
      mockExecCommand.mockImplementation((command) => command === "where.exe"
        ? execResult(wtPath)
        : command === "pwsh" ? execResult("", null) : command === "powershell" ? execResult("found") : execResult());
      adapter.spawn(options);
      expect(lastArgs()).toContain("powershell");
      expect(lastArgs()).toContain("-EncodedCommand");
    });

    it("reports missing PowerShell rather than assuming it is installed", () => {
      mockExecCommand.mockImplementation(command => command === "where.exe" ? execResult(wtPath) : execResult("", null));
      expect(() => adapter.spawn(options)).toThrow("requires PowerShell");
    });

    it("creates a true new window with -w -1 new-tab", () => {
      expect(adapter.spawnWindow(options)).toMatch(/^windows_win_\d+_worker$/);
      expect(lastArgs().slice(0, 5)).toEqual(["-w", "-1", "new-tab", "--title", "team: worker"]);
      expect(lastArgs()).not.toContain("new-window");
    });
  });

  describe("WSL", () => {
    beforeEach(useWsl);

    it("launches the same distribution and Linux user, not Windows PowerShell", () => {
      adapter.spawn(options);
      expect(mockExecCommand.mock.calls.at(-1)![0]).toBe(wslWtPath);
      const args = lastArgs();
      expect(args.slice(args.indexOf("wsl.exe"), args.indexOf("-e"))).toEqual([
        "wsl.exe", "--distribution", "NixOS", "--user", "test-user", "--exec", "/nix/store/test-node/bin/node",
      ]);
      expect(wslBootstrap()).toContain('cwd: "/project"');
      expect(wslBootstrap()).toContain('"PI_TEAM_NAME":"team"');
      expect(wslBootstrap()).toContain('"PATH":"/test/bin"');
      expect(mockExecCommand.mock.calls.some(([command]) => command === "pwsh" || command === "powershell")).toBe(false);
    });

    it("does not forward a parent terminal's interop/session or arbitrary environment", () => {
      adapter.spawn({ ...options, env: { ...options.env, WT_SESSION: "parent", WSL_INTEROP: "parent", OTHER: "ignored" } });
      const script = wslBootstrap();
      expect(script).not.toContain("WT_SESSION");
      expect(script).not.toContain("WSL_INTEROP");
      expect(script).not.toContain("ignored");
    });

    it("uses new-tab in a new window for WSL as well", () => {
      adapter.spawnWindow(options);
      expect(lastArgs().slice(0, 3)).toEqual(["-w", "-1", "new-tab"]);
      expect(lastArgs()).toContain("wsl.exe");
    });

    it("resolves Node for standalone Pi installs", () => {
      Object.defineProperty(process, "execPath", { value: "/opt/pi", configurable: true });
      adapter.spawn(options);
      expect(fs.accessSync).toHaveBeenCalledWith("/test/bin/node", fs.constants.X_OK);
      expect(lastArgs()).toContain("/test/bin/node");
      expect(lastArgs()).not.toContain("/opt/pi");
    });

    it("reports a missing Node runtime for standalone installs", () => {
      Object.defineProperty(process, "execPath", { value: "/opt/pi", configurable: true });
      vi.mocked(fs.accessSync).mockImplementation(candidate => {
        if (candidate.toString() !== wslWtPath) throw new Error("not found");
      });
      expect(() => adapter.spawn(options)).toThrow("requires Node.js in PATH");
    });

    it.skipIf(originalPlatform === "win32").each([false, true])("executes the bootstrap preserving values and crash codes (intentional stop: %s)", intentionalStop => {
      const testRoot = fs.mkdtempSync(path.join(process.cwd(), ".wsl-bootstrap-test-"));
      vi.spyOn(os, "tmpdir").mockReturnValue(testRoot);
      try {
        const cwd = path.join(testRoot, "space ' $value; unicode-中文");
        fs.mkdirSync(cwd);
        const output = path.join(cwd, "result.json");
        const testPath = `${path.dirname(originalExecPath)}:/bin`;
        const childScript = `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({cwd:process.cwd(),team:process.env.PI_TEAM_NAME,text:process.env.PI_TEXT,path:process.env.PATH,session:process.env.WT_SESSION}))`;
        const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        const handle = adapter.spawn({
          ...options, cwd,
          command: `${quote(originalExecPath)} -e ${quote(childScript)}; exit 7`,
          env: { ...options.env, PI_TEXT: "quote ' \" $value; 中文\nnext", PATH: testPath, WT_SESSION: "do-not-copy" },
        });
        if (intentionalStop) {
          // Handles survive adapter recreation; a repeated stop is idempotent.
          new WindowsAdapter().prepareShutdown(handle);
          adapter.prepareShutdown(handle);
        }
        const args = lastArgs();
        const evalIndex = args.indexOf("-e");
        expect(args.every(arg => !arg.includes(";"))).toBe(true);
        const result = spawnSync(originalExecPath, args.slice(evalIndex), {
          encoding: "utf8", cwd: testRoot,
          env: { PATH: testPath, HOME: testRoot, USER: "test-user", WT_SESSION: "child-session" },
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(intentionalStop ? 0 : 7);
        expect(fs.readdirSync(testRoot)).toEqual(["space ' $value; unicode-中文"]);
        expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
          cwd, team: "team", text: "quote ' \" $value; 中文\nnext", path: testPath, session: "child-session",
        });
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    });
  });

  describe("shutdown", () => {
    it.skipIf(originalPlatform === "win32").each([false, true])("distinguishes a requested SIGKILL from a crash (intentional stop: %s)", intentionalStop => {
      useWsl();
      const testRoot = fs.mkdtempSync(path.join(process.cwd(), ".wsl-shutdown-test-"));
      vi.spyOn(os, "tmpdir").mockReturnValue(testRoot);
      try {
        const handle = adapter.spawnWindow({
          ...options, cwd: testRoot, command: "kill -KILL $$",
          env: { PATH: `${path.dirname(originalExecPath)}:/bin` },
        });
        if (intentionalStop) adapter.prepareShutdown(handle);
        const args = lastArgs();
        const result = spawnSync(originalExecPath, args.slice(args.indexOf("-e")), {
          encoding: "utf8", cwd: testRoot,
          env: { PATH: `${path.dirname(originalExecPath)}:/bin`, HOME: testRoot, USER: "test-user" },
        });
        expect(result.status).toBe(intentionalStop ? 0 : 1);
        expect(fs.readdirSync(testRoot)).toEqual([]);
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    });

    it("does not write markers for old/native handles or arbitrary paths", () => {
      const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
      for (const handle of ["windows_123_worker", "windows_win_123_worker", "windows_../../bad", "tmux_123"]) {
        adapter.prepareShutdown(handle);
      }
      expect(write).not.toHaveBeenCalled();
    });

    it("reports marker errors instead of silently turning a shutdown into a crash", () => {
      useWsl();
      const handle = adapter.spawn(options);
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
      expect(() => adapter.prepareShutdown(handle)).toThrow("permission denied");
    });
  });

  describe("layout and diagnostics", () => {
    it("splits subsequent panes horizontally without a nonexistent wt list", () => {
      adapter.spawn(options);
      adapter.spawn(options);
      expect(lastArgs()).toContain("--horizontal");
      expect(lastArgs()).not.toContain("--vertical");
    });

    it("does not advance the split direction when spawning fails", () => {
      mockExecCommand.mockImplementation(command => command === "where.exe" ? execResult(wtPath)
        : command === "pwsh" ? execResult("found") : execResult("", 1, "invalid arguments"));
      expect(() => adapter.spawn(options)).toThrow("invalid arguments");
      expect(() => adapter.spawn(options)).toThrow("invalid arguments");
      expect(lastArgs()).toContain("--vertical");
    });

    it("retains synthetic UI handles as startup fallbacks", () => {
      expect(adapter.isAlive("windows_123_worker")).toBe(true);
      expect(adapter.isAlive("tmux_123")).toBe(false);
      expect(adapter.isWindowAlive("windows_win_123_worker")).toBe(true);
      expect(adapter.isWindowAlive("windows_123_worker")).toBe(false);
      adapter.kill("windows_123_worker");
      adapter.killWindow("windows_win_123_worker");
      adapter.setWindowTitle("windows_win_123_worker", "title");
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it("uses OSC for current titles and strips terminal control characters", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        adapter.setTitle("team\x07\x1b\n: worker");
        expect(write).toHaveBeenCalledWith("\x1b]0;team: worker\x07");
        expect(mockExecCommand).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
        if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    });
  });
});
