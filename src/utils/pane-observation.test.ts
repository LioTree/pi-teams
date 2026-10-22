import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../adapters/tmux-adapter";
import * as terminalAdapter from "./terminal-adapter";
import { observeTmuxPane } from "./pane-observation";

afterEach(() => vi.restoreAllMocks());

describe("confirmed tmux pane absence", () => {
  it("distinguishes successful absence from command failure and thrown errors", () => {
    const exec = vi.spyOn(terminalAdapter, "execCommand");
    const terminal = new TmuxAdapter();
    exec.mockReturnValue({ stdout: "%1\n%2\n", stderr: "", status: 0 });
    expect(terminal.panePresence("%2")).toBe("present");
    expect(terminal.panePresence("%3")).toBe("missing");
    exec.mockReturnValue({ stdout: "", stderr: "transient server error", status: 1 });
    expect(terminal.panePresence("%2")).toBe("unknown");
    exec.mockImplementation(() => { throw new Error("spawn failure"); });
    expect(terminal.panePresence("%2")).toBe("unknown");
  });

  it("does not query another adapter's synthetic IDs", () => {
    const exec = vi.spyOn(terminalAdapter, "execCommand");
    const terminal = new TmuxAdapter();
    for (const id of ["wezterm_window_123", "iterm_pane_1", "windows_123_A", ""]) {
      expect(terminal.panePresence(id)).toBe("unknown");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not infer individual hiding if the lead anchor also disappeared", () => {
    const exec = vi.spyOn(terminalAdapter, "execCommand");
    exec.mockReturnValue({ stdout: "%9\n", stderr: "", status: 0 });
    expect(observeTmuxPane(new TmuxAdapter(), "%2", "%1")).toBe("unknown");
    exec.mockReturnValue({ stdout: "%1\n%9\n", stderr: "", status: 0 });
    expect(observeTmuxPane(new TmuxAdapter(), "%2", "%1")).toBe("missing");
  });

  it("requires a known addressable pane, not merely a window ID or another terminal", () => {
    const terminal: any = { name: "tmux", isAlive: vi.fn(() => false) };
    expect(observeTmuxPane(terminal, undefined)).toBe("unknown");
    expect(observeTmuxPane({ ...terminal, name: "wezterm" }, "%2")).toBe("unknown");
    expect(terminal.isAlive).not.toHaveBeenCalled();
  });
});
