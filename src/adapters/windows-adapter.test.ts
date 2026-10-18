/**
 * Windows Adapter Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock at module level - this is hoisted by Vitest
vi.mock("../utils/terminal-adapter", () => ({
  execCommand: vi.fn(),
  TerminalAdapter: class {},
}));

// Import after mock
import { execCommand } from "../utils/terminal-adapter";
import { parseWindowsList, selectWindowsTarget, WindowsAdapter } from "./windows-adapter";

const mockExecCommand = vi.mocked(execCommand);
const execResult = (stdout = "", status: number | null = 0) => ({ stdout, stderr: "", status });

const originalPlatform = process.platform;

describe("WindowsAdapter", () => {
  let adapter: WindowsAdapter;

  beforeEach(() => {
    // Create a fresh adapter for each test
    adapter = new WindowsAdapter();
    vi.resetAllMocks();
    vi.clearAllMocks();

    // Reset environment
    delete process.env.TMUX;
    delete process.env.ZELLIJ;
    delete process.env.WEZTERM_PANE;
    delete process.env.WT_SESSION;

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  describe("basics", () => {
    it("should have the correct name", () => {
      expect(adapter.name).toBe("Windows");
    });
  });

  describe("detect()", () => {
    it("should detect when on Windows and wt is available", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockExecCommand.mockReturnValue(execResult("Windows Terminal"));

      expect(adapter.detect()).toBe(true);
    });

    it("should not detect when not on Windows", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(adapter.detect()).toBe(false);
    });

    it("should not detect when TMUX is set", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.TMUX = "/tmp/tmux";

      expect(adapter.detect()).toBe(false);
    });

    it("should not detect when ZELLIJ is set", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.ZELLIJ = "true";

      expect(adapter.detect()).toBe(false);
    });

    it("should not detect when WEZTERM_PANE is set", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.WEZTERM_PANE = "123";

      expect(adapter.detect()).toBe(false);
    });
  });

  describe("window target", () => {
    it("parses flat pane rows and nested windows", () => {
      expect(parseWindowsList('[{"window":2,"pid":9},{"window":2,"pid":8},{"window":1,"pid":4}]'))
        .toEqual([
          { id: "2", panes: [{ pid: 9 }, { pid: 8 }] },
          { id: "1", panes: [{ pid: 4 }] },
        ]);
      expect(parseWindowsList(JSON.stringify({
        windows: [{ id: "lead-window", tabs: [{ panes: [{ pid: 4 }, { pid: 5 }] }] }],
      }))).toEqual([{ id: "lead-window", pid: undefined, panes: [{ pid: 4 }, { pid: 5 }] }]);
    });

    it("targets the lead session or the window that owns this pid, not the first window", () => {
      const windows = parseWindowsList(JSON.stringify([
        { window: 1, pid: 10 },
        { window: 2, pid: 20 },
        { window: 2, pid: 21 },
      ]));
      expect(selectWindowsTarget(windows, { session: "{lead-session}", pid: 20 }).windowId).toBe("{lead-session}");
      expect(selectWindowsTarget(windows, { pid: 21 })).toEqual({
        windowId: "2",
        panes: [{ pid: 20 }, { pid: 21 }],
      });
      expect(selectWindowsTarget([], { pid: 1 }).windowId).toBe("0");
    });

    it("passes the lead window to wt split-pane", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.WT_SESSION = "{lead-session}";
      mockExecCommand.mockReturnValueOnce(execResult("wt"));
      mockExecCommand.mockReturnValueOnce(execResult("found"));
      mockExecCommand.mockReturnValueOnce(execResult(JSON.stringify([
        { window: 1, pid: 10 },
        { window: 2, pid: 20 },
      ])));
      mockExecCommand.mockReturnValueOnce(execResult());

      adapter.spawn({
        name: "peer",
        cwd: "/test/path",
        command: "pi",
        env: { PI_TEAM_NAME: "team1" },
      });

      const split = mockExecCommand.mock.calls.find(call => call[1]?.includes("split-pane"));
      expect(split?.[1]?.slice(0, 3)).toEqual(["-w", "{lead-session}", "split-pane"]);
      delete process.env.WT_SESSION;
    });
  });

  describe("spawn()", () => {
    it("should spawn first pane on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // Mock findWtBinary check
      mockExecCommand.mockReturnValueOnce(execResult("wt"));
      // Mock findPsBinary check (pwsh found)
      mockExecCommand.mockReturnValueOnce(execResult("found"));
      // Mock getPanes - no existing panes
      mockExecCommand.mockReturnValueOnce(execResult("[]"));
      // Mock actual spawn
      mockExecCommand.mockReturnValueOnce(execResult());

      const paneId = adapter.spawn({
        name: "test-agent",
        cwd: "/test/path",
        command: "pi --model gpt-4",
        env: { PI_TEAM_NAME: "team1", PI_AGENT_NAME: "agent1" },
      });

      // Returns synthetic ID: windows_<timestamp>_<name>
      expect(paneId).toMatch(/^windows_\d+_test-agent$/);
    });

    it("should spawn subsequent pane on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // Mock findWtBinary check
      mockExecCommand.mockReturnValueOnce(execResult("wt"));
      // Mock findPsBinary check (pwsh found)
      mockExecCommand.mockReturnValueOnce(execResult("found"));
      // Mock getPanes - existing panes
      mockExecCommand.mockReturnValueOnce(execResult('[{"window":1}]'));
      // Mock actual spawn
      mockExecCommand.mockReturnValueOnce(execResult());

      const paneId = adapter.spawn({
        name: "test-agent-2",
        cwd: "/test/path",
        command: "pi --model gpt-4",
        env: { PI_TEAM_NAME: "team1", PI_AGENT_NAME: "agent1" },
      });

      // Returns synthetic ID: windows_<timestamp>_<name>
      expect(paneId).toMatch(/^windows_\d+_test-agent-2$/);
    });

    it("should throw error when wt binary not found", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // Mock findWtBinary - not found
      mockExecCommand.mockReturnValue(execResult("", 1));

      expect(() =>
        adapter.spawn({
          name: "test-agent",
          cwd: "/test/path",
          command: "pi",
          env: {},
        })
      ).toThrow();
    });
  });

  describe("supportsWindows()", () => {
    it("should return true when wt is available", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockExecCommand.mockReturnValue(execResult("wt found"));

      expect(adapter.supportsWindows()).toBe(true);
    });

    it("should return true on Windows even if wt check fails (fallback)", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // The Windows adapter has a fallback that assumes wt exists on Windows
      mockExecCommand.mockReturnValue(execResult("", 1));

      // On Windows, the adapter falls back to assuming wt exists
      expect(adapter.supportsWindows()).toBe(true);
    });
  });

  describe("spawnWindow()", () => {
    it("should spawn a new window", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // Mock findWtBinary check
      mockExecCommand.mockReturnValueOnce(execResult("wt"));
      // Mock findPsBinary check (pwsh found)
      mockExecCommand.mockReturnValueOnce(execResult("found"));
      // Mock actual spawn
      mockExecCommand.mockReturnValueOnce(execResult());

      const windowId = adapter.spawnWindow({
        name: "team-lead",
        cwd: "/test/path",
        command: "pi",
        env: { PI_TEAM_NAME: "team1", PI_AGENT_NAME: "team-lead" },
        teamName: "team1",
      });

      // Returns synthetic ID: windows_win_<timestamp>_<name>
      expect(windowId).toMatch(/^windows_win_\d+_team-lead$/);
    });

    it("should fallback to powershell when pwsh is not available", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      // Mock findWtBinary check
      mockExecCommand.mockReturnValueOnce(execResult("wt"));
      // Mock findPsBinary check - pwsh fails, powershell succeeds
      mockExecCommand.mockReturnValueOnce(execResult("", 1)); // pwsh not found
      mockExecCommand.mockReturnValueOnce(execResult("found")); // powershell found
      // Mock actual spawn
      mockExecCommand.mockReturnValueOnce(execResult());

      const windowId = adapter.spawnWindow({
        name: "team-lead",
        cwd: "/test/path",
        command: "pi",
        env: {},
      });

      expect(windowId).toMatch(/^windows_win_\d+_team-lead$/);
      // Verify that powershell was used (check the call args)
      const lastCall = mockExecCommand.mock.calls[mockExecCommand.mock.calls.length - 1];
      expect(lastCall[0]).toBe("wt");
      // The command should use 'powershell' not 'pwsh'
      expect(lastCall[1]).toContain("powershell");
    });
  });

  describe("kill()", () => {
    it("should handle kill gracefully for windows pane", () => {
      // Should not throw
      adapter.kill("windows_123_test-pane");
    });

    it("should ignore non-windows pane IDs", () => {
      // Should not throw for non-windows pane IDs
      adapter.kill("tmux_pane-123");
      adapter.kill("iterm_tab-456");
    });
  });

  describe("killWindow()", () => {
    it("should handle killWindow gracefully", () => {
      // Should not throw
      adapter.killWindow("windows_win_123_test-window");
    });
  });

  describe("isAlive()", () => {
    it("should return true for windows pane ID", () => {
      expect(adapter.isAlive("windows_123_test")).toBe(true);
    });

    it("should return false for non-windows pane ID", () => {
      expect(adapter.isAlive("tmux_pane-123")).toBe(false);
    });
  });

  describe("isWindowAlive()", () => {
    it("should return true for windows window ID", () => {
      expect(adapter.isWindowAlive("windows_win_123_test")).toBe(true);
    });

    it("should return false for non-windows window ID", () => {
      expect(adapter.isWindowAlive("iterm_window-123")).toBe(false);
    });
  });

  describe("setTitle()", () => {
    it("should set tab title gracefully", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockExecCommand.mockReturnValue(execResult());

      // Should not throw
      adapter.setTitle("New Title");
    });
  });

  describe("setWindowTitle()", () => {
    it("should gracefully handle setWindowTitle limitation", () => {
      // Windows adapter doesn't support setWindowTitle, should not throw
      adapter.setWindowTitle("windows_win_123_test", "New Title");
    });
  });
});
