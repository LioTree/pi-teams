import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { execCommand } from "./terminal-adapter";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const mockSpawn = vi.mocked(spawnSync);

describe("terminal command diagnostics", () => {
  it("preserves missing executable/WSL interop errors", () => {
    mockSpawn.mockReturnValue({
      pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null,
      error: new Error("spawnSync wt.exe ENOENT"),
    });
    expect(execCommand("wt.exe", ["split-pane"])).toEqual({
      stdout: "", stderr: "spawnSync wt.exe ENOENT", status: null,
    });
  });

  it("prefers stderr when the command supplied diagnostics", () => {
    mockSpawn.mockReturnValue({
      pid: 123, output: [], stdout: "", stderr: "invalid arguments", status: 1, signal: null,
    });
    expect(execCommand("wt.exe", [])).toEqual({
      stdout: "", stderr: "invalid arguments", status: 1,
    });
  });
});
