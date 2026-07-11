import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJsonSync } from "./atomic-file";

describe("atomic file writes", () => {
  const dir = path.join(os.tmpdir(), `pi-teams-atomic-${process.pid}`);
  const file = path.join(dir, "state.json");

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("atomically creates and replaces JSON without leaving temp files", () => {
    atomicWriteJsonSync(file, { version: 1 });
    atomicWriteJsonSync(file, { version: 2 });

    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ version: 2 });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("preserves the old file and cleans up the temp file when rename fails", () => {
    atomicWriteJsonSync(file, { version: 1 });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    expect(() => atomicWriteJsonSync(file, { version: 2 })).toThrow("rename failed");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ version: 1 });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });
});
