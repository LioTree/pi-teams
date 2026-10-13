/**
 * Windows Terminal adapter for native Windows and WSL.
 *
 * wt manages the UI; WSL teammates remain Linux processes, so the extension's
 * existing runtime leases, PID checks and shutdown logic continue to apply.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class WindowsAdapter implements TerminalAdapter {
  readonly name = "Windows";

  private wtPath: string | null = null;
  private psPath: string | null = null;
  private spawnedPanes = 0;

  private isWsl(): boolean {
    return process.platform === "linux" && !!process.env.WSL_DISTRO_NAME && !!process.env.WT_SESSION;
  }

  private findLinuxBinary(binary: string): string | null {
    for (const directory of (process.env.PATH ?? "").split(path.posix.delimiter)) {
      if (!directory) continue;
      const candidate = path.posix.join(directory, binary);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present/executable in this PATH entry.
      }
    }
    return null;
  }

  private findWtBinary(): string | null {
    if (this.wtPath) return this.wtPath;
    if (this.isWsl()) {
      // Do not start a shell just to search PATH. Shell initialization can
      // change PATH or block, and detect() runs inside the extension factory.
      this.wtPath = this.findLinuxBinary("wt.exe");
      return this.wtPath;
    }
    if (process.platform !== "win32") return null;

    // Resolve without launching wt: unsupported probes can open a window,
    // and spawnSync reports ENOENT via status rather than throwing.
    const result = execCommand("where.exe", ["wt.exe"]);
    if (result.status !== 0) return null;
    this.wtPath = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
    return this.wtPath;
  }

  private findPsBinary(): string {
    if (this.psPath) return this.psPath;

    for (const binary of ["pwsh", "powershell"]) {
      const result = execCommand(binary, ["-NoProfile", "-Command", "Write-Output 'found'"]);
      if (result.status === 0 && result.stdout.trim() === "found") {
        this.psPath = binary;
        return binary;
      }
    }
    throw new Error("Windows Terminal requires PowerShell (pwsh or powershell) on native Windows.");
  }

  detect(): boolean {
    if (process.env.TMUX || process.env.ZELLIJ || process.env.WEZTERM_PANE ||
        process.env.CMUX_SOCKET_PATH || process.env.CMUX_WORKSPACE_ID) {
      return false;
    }
    return this.findWtBinary() !== null;
  }

  private piEnvironment(options: SpawnOptions): Record<string, string> {
    return Object.fromEntries(Object.entries(options.env)
      .filter(([key, value]) => /^PI_[A-Za-z0-9_]+$/.test(key) && typeof value === "string"));
  }

  private shutdownMarker(paneId: string): string | null {
    const match = /^windows_(?:win_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(paneId);
    return match ? path.join(os.tmpdir(), `pi-teams-wt-${match[1]}.shutdown`) : null;
  }

  prepareShutdown(paneOrWindowId: string): void {
    const marker = this.shutdownMarker(paneOrWindowId);
    if (!marker) return; // Native Windows and handles from older launchers.
    try {
      fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private buildWslCommand(options: SpawnOptions, shutdownMarker: string): string[] {
    // Reuse the lead's exact Node executable, including Nix store paths. For a
    // standalone Pi binary, resolve Node from the lead's PATH instead.
    let nodeBinary = process.execPath;
    if (path.basename(nodeBinary) !== "node") {
      nodeBinary = this.findLinuxBinary("node") ?? "";
      if (!nodeBinary) throw new Error("Windows Terminal WSL spawning requires Node.js in PATH.");
    }

    const env = this.piEnvironment(options);
    if (options.env.PATH !== undefined) env.PATH = options.env.PATH;
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    // Some distro shells initialize/alter PATH even for sh -c. Restore the
    // lead's values after that initialization, not just before shell startup.
    const shellCommand = [
      ...Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`),
      options.command,
    ].join("\n");

    // wt treats semicolons as action separators, even inside a child command.
    // Encode the bootstrap so command text, quotes and environment values never
    // reach that parser. Only PI_* and PATH are overlaid: the new terminal keeps
    // its own WT_SESSION/WSL_INTEROP and other host-generated environment.
    const bootstrap = [
      `const {spawnSync} = require("node:child_process");`,
      `const result = spawnSync("/bin/sh", ["-c", ${JSON.stringify(shellCommand)}], {`,
      `cwd: ${JSON.stringify(options.cwd)},`,
      `env: {...process.env, ...${JSON.stringify(env)}}, stdio: "inherit"`,
      `});`,
      `const fs = require("node:fs");`,
      `const marker = ${JSON.stringify(shutdownMarker)};`,
      `const intentionalShutdown = fs.existsSync(marker);`,
      `if (intentionalShutdown) fs.rmSync(marker, {force: true});`,
      `if (result.error && !intentionalShutdown) console.error(result.error.message);`,
      `process.exit(intentionalShutdown ? 0 : (result.status ?? 1));`,
    ].join("\n");

    return [
      "wsl.exe", "--distribution", process.env.WSL_DISTRO_NAME!,
      "--user", os.userInfo().username,
      "--exec", nodeBinary, "-e",
      "eval(Buffer.from(process.argv[1],process.argv[2]).toString())",
      Buffer.from(bootstrap, "utf8").toString("base64"), "base64",
    ];
  }

  private buildCommand(options: SpawnOptions, paneId: string): string[] {
    if (this.isWsl()) return this.buildWslCommand(options, this.shutdownMarker(paneId)!);

    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Set-Location -LiteralPath ${quote(options.cwd)}`,
      ...Object.entries(this.piEnvironment(options)).map(([key, value]) => `$env:${key}=${quote(value)}`),
      options.command,
      "exit $LASTEXITCODE",
    ].join("; ");
    // -EncodedCommand also avoids wt's semicolon parsing and works in PS 5.1.
    return [this.findPsBinary(), "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }

  private launch(options: SpawnOptions, separateWindow: boolean): string {
    const wtBinary = this.findWtBinary();
    if (!wtBinary) throw new Error("Windows Terminal (wt.exe) CLI binary not found or unavailable in this environment.");

    // The UUID also identifies a per-launch shutdown marker outside the team
    // directory, which team_shutdown may remove before the bridge exits.
    const paneId = this.isWsl()
      ? `windows_${separateWindow ? "win_" : ""}${randomUUID()}`
      : `windows_${separateWindow ? "win_" : ""}${Date.now()}_${options.name}`;
    const title = options.teamName ? `${options.teamName}: ${options.name}` : options.name;
    const action = separateWindow
      ? ["-w", "-1", "new-tab"]
      : ["-w", "0", "split-pane", this.spawnedPanes === 0 ? "--vertical" : "--horizontal", "--size", "0.5"];
    const result = execCommand(wtBinary, [
      ...action, "--title", title, "--suppressApplicationTitle", "--", ...this.buildCommand(options, paneId),
    ]);
    if (result.status !== 0) {
      throw new Error(`Windows Terminal ${separateWindow ? "spawn-window" : "spawn"} failed (status ${result.status}): ${result.stderr}`);
    }
    if (!separateWindow) this.spawnedPanes++;

    // wt does not return pane IDs. These are UI handles, not liveness evidence;
    // the extension prefers the teammate's runtime PID once it has registered.
    return paneId;
  }

  spawn(options: SpawnOptions): string {
    return this.launch(options, false);
  }

  spawnWindow(options: SpawnOptions): string {
    return this.launch(options, true);
  }

  supportsWindows(): boolean {
    return this.findWtBinary() !== null;
  }

  kill(_paneId: string): void {
    // No kill-pane action exists in wt. The extension terminates WSL teammates
    // via their registered Linux PID; terminal close-on-exit controls the UI.
  }

  killWindow(_windowId: string): void {
    // As above: process shutdown, not a fabricated wt kill-window command.
  }

  isAlive(paneId: string): boolean {
    // Startup fallback only. Runtime PID/start-token checks take precedence in
    // the extension; wt cannot query arbitrary panes (there is no wt list).
    return !!paneId?.startsWith("windows_");
  }

  isWindowAlive(windowId: string): boolean {
    return !!windowId?.startsWith("windows_win_");
  }

  setTitle(title: string): void {
    // Set the current terminal title via OSC, without launching another wt.
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`);
    }
  }

  setWindowTitle(_windowId: string, _title: string): void {
    // Titles of other windows can only be set at creation via --title.
  }
}
