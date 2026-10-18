/**
 * Windows Terminal/PowerShell Adapter
 *
 * Implements the TerminalAdapter interface for Windows with PowerShell.
 * Uses wt (Windows Terminal) CLI for pane management and PowerShell for command execution.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export interface WindowsPane {
  pid?: number;
}

export interface WindowsWindow {
  id: string;
  pid?: number;
  panes: WindowsPane[];
}

/** `wt list --format json` is either flat pane rows or windows with tabs/panes. */
export function parseWindowsList(stdout: string): WindowsWindow[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { windows?: unknown }).windows)
      ? (data as { windows: unknown[] }).windows
      : [];
  if (raw.length === 0) return [];
  const first = raw[0] as { window?: unknown; tabs?: unknown; panes?: unknown };
  if (first.window !== undefined && first.tabs === undefined && first.panes === undefined) {
    const byWindow = new Map<string, WindowsPane[]>();
    for (const row of raw as Array<{ window?: unknown; pid?: unknown }>) {
      const id = String(row.window);
      const panes = byWindow.get(id) ?? [];
      panes.push({ pid: typeof row.pid === "number" ? row.pid : undefined });
      byWindow.set(id, panes);
    }
    return [...byWindow].map(([id, panes]) => ({ id, panes }));
  }
  return (raw as Array<Record<string, unknown>>).map((win, index) => {
    const tabs = Array.isArray(win.tabs) ? win.tabs as Array<{ panes?: unknown }> : [];
    const nested = tabs.flatMap(tab => Array.isArray(tab.panes) ? tab.panes : []);
    const direct = Array.isArray(win.panes) ? win.panes : [];
    const panes = [...direct, ...nested].map(pane => {
      const pid = pane && typeof pane === "object" ? (pane as { pid?: unknown }).pid : undefined;
      return { pid: typeof pid === "number" ? pid : undefined };
    });
    const id = win.id ?? win.name ?? index;
    return { id: String(id), pid: typeof win.pid === "number" ? win.pid : undefined, panes };
  });
}

/**
 * Prefer the window this process is actually in. `WT_SESSION` is that
 * window's id. Otherwise match a pane pid. `-w 0` is WT's current window
 * only as a last resort, when the list does not identify us.
 */
export function selectWindowsTarget(
  windows: readonly WindowsWindow[],
  options: { session?: string; pid: number },
): { windowId: string; panes: WindowsPane[] } {
  const session = options.session?.trim();
  if (session) {
    return { windowId: session, panes: windows.find(win => win.id === session)?.panes ?? [] };
  }
  const owner = windows.find(win => win.pid === options.pid || win.panes.some(pane => pane.pid === options.pid));
  if (owner) return { windowId: owner.id, panes: owner.panes };
  if (windows[0]) return { windowId: windows[0].id, panes: windows[0].panes };
  return { windowId: "0", panes: [] };
}

export class WindowsAdapter implements TerminalAdapter {
  readonly name = "Windows";

  // Common paths where wt CLI might be found on Windows
  private possiblePaths = [
    "wt",  // In PATH
    "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe",  // WindowsApps
    "C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",  // User Local
  ];

  private wtPath: string | null = null;
  private psPath: string | null = null;

  private findWtBinary(): string | null {
    if (this.wtPath !== null) {
      return this.wtPath;
    }

    // On Windows, wt.exe is usually available via WindowsApps
    // Try different methods to detect it
    try {
      // Method 1: Try running wt directly (works in Windows Terminal)
      const result = execCommand("wt", ["--version"]);
      // wt doesn't have a proper --version, but if it exists, it will fail with a specific error
      // If it doesn't exist, spawnSync will throw
      this.wtPath = "wt";
      return "wt";
    } catch {
      // Method 2: Check common paths
      const fs = require("fs");
      const possiblePaths = [
        `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe`,
        "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe",
      ];
      
      for (const p of possiblePaths) {
        try {
          if (fs.existsSync(p)) {
            this.wtPath = p;
            return p;
          }
        } catch {}
      }
    }

    // Method 3: Just assume wt is available on Windows and let spawn fail if not
    // This is a reasonable fallback for most Windows 10/11 systems
    if (process.platform === "win32") {
      this.wtPath = "wt";
      return "wt";
    }

    this.wtPath = null;
    return null;
  }

  /**
   * Find the PowerShell binary to use.
   * Prefers PowerShell Core (pwsh) if available, falls back to Windows PowerShell (powershell).
   */
  private findPsBinary(): string {
    if (this.psPath !== null) {
      return this.psPath;
    }

    // Try pwsh (PowerShell Core / PowerShell 7+) first
    try {
      const result = execCommand("pwsh", ["-NoProfile", "-Command", "echo 'found'"]);
      if (result.status === 0 && result.stdout.trim() === "found") {
        this.psPath = "pwsh";
        return "pwsh";
      }
    } catch {
      // pwsh not found, try powershell
    }

    // Fall back to powershell (Windows PowerShell 5.1)
    try {
      const result = execCommand("powershell", ["-NoProfile", "-Command", "echo 'found'"]);
      if (result.status === 0 && result.stdout.trim() === "found") {
        this.psPath = "powershell";
        return "powershell";
      }
    } catch {
      // powershell not found either
    }

    // Default to powershell as it's built into Windows
    this.psPath = "powershell";
    return "powershell";
  }

  detect(): boolean {
    // Windows only - check platform
    if (process.platform !== "win32") {
      return false;
    }

    // Don't use if inside tmux, Zellij, or WezTerm
    // Note: we DO detect in mintty/Git Bash because we can still use Windows Terminal
    if (process.env.TMUX || process.env.ZELLIJ || process.env.WEZTERM_PANE) {
      return false;
    }

    // On Windows, always try to use Windows Terminal
    // findWtBinary() will return "wt" as fallback
    return true;
  }

  /**
   * Panes in the lead's Windows Terminal window, plus the id `wt -w` must
   * target. `split-pane` without `-w` opens another window when more than
   * one exists, or when this process is not WT's "current" window.
   */
  private currentWindow(): { windowId: string; panes: WindowsPane[] } {
    const wtBin = this.findWtBinary();
    if (!wtBin) return selectWindowsTarget([], { session: process.env.WT_SESSION, pid: process.pid });
    try {
      const result = execCommand(wtBin, ["list", "--format", "json"]);
      if (result.status !== 0 || !result.stdout.trim()) {
        return selectWindowsTarget([], { session: process.env.WT_SESSION, pid: process.pid });
      }
      return selectWindowsTarget(parseWindowsList(result.stdout), {
        session: process.env.WT_SESSION,
        pid: process.pid,
      });
    } catch {
      return selectWindowsTarget([], { session: process.env.WT_SESSION, pid: process.pid });
    }
  }

  spawn(options: SpawnOptions): string {
    const wtBin = this.findWtBinary();
    if (!wtBin) {
      throw new Error("Windows Terminal (wt) CLI binary not found.");
    }

    const psBin = this.findPsBinary();
    const current = this.currentWindow();
    const panes = current.panes;

    // Build environment variables for PowerShell
    const envVars = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `$env:${k}='${v}'`)
      .join(" ");

    // Build the PowerShell command
    // Use icm (Invoke-Command) to run in a specific directory with env vars
    const psCommand = `cd '${options.cwd}'; ${envVars}; ${options.command}`;

    // Use wt split-pane command
    // First pane splits vertically (right), subsequent panes stack
    const isFirstPane = panes.length <= 1;

    let wtArgs: string[];

    if (isFirstPane) {
      wtArgs = [
        "-w", current.windowId,
        "split-pane",
        "--vertical",
        "--size", "50%",
        "--", psBin, "-NoExit", "-Command", psCommand
      ];
    } else {
      wtArgs = [
        "-w", current.windowId,
        "split-pane",
        "--horizontal",
        "--size", "50%",
        "--", psBin, "-NoExit", "-Command", psCommand
      ];
    }

    const result = execCommand(wtBin, wtArgs);
    if (result.status !== 0) {
      throw new Error(`Windows Terminal spawn failed: ${result.stderr}`);
    }

    // wt doesn't return a pane ID, so we create a synthetic one
    // We'll use a timestamp + name to make it unique
    const syntheticId = `windows_${Date.now()}_${options.name}`;
    return syntheticId;
  }

  closesProcesses(): boolean {
    return false;
  }

  kill(paneId: string): void {
    if (!paneId?.startsWith("windows_")) return;

    // Windows Terminal doesn't have a direct kill-pane command via CLI
    // The pane will close when the PowerShell process exits
    // We could potentially kill the process if we tracked PIDs, but for now
    // we'll just let the user close it manually or the process ends naturally
  }

  isAlive(paneId: string): boolean {
    if (!paneId?.startsWith("windows_")) return false;

    // Windows Terminal doesn't provide an easy way to check pane status via CLI
    // We assume the pane is alive for simplicity
    // In production, you might want to track PIDs and check process status
    return true;
  }

  setTitle(title: string): void {
    const wtBin = this.findWtBinary();
    if (!wtBin) return;

    try {
      // Set tab title (Windows Terminal uses tab titles, not pane titles)
      const args = process.env.WT_SESSION
        ? ["-w", process.env.WT_SESSION, "set-tab-title", title]
        : ["set-tab-title", title];
      execCommand(wtBin, args);
    } catch {
      // Silently fail
    }
  }

  /**
   * Windows Terminal supports spawning separate OS windows via New Tab or New Window
   */
  supportsWindows(): boolean {
    return this.findWtBinary() !== null;
  }

  /**
   * Spawn a new separate OS window with the given options.
   * Uses `wt new-window` or starts a new wt instance.
   */
  spawnWindow(options: SpawnOptions): string {
    const wtBin = this.findWtBinary();
    if (!wtBin) {
      throw new Error("Windows Terminal (wt) CLI binary not found.");
    }

    const psBin = this.findPsBinary();

    // Build environment variables for PowerShell
    const envVars = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `$env:${k}='${v}'`)
      .join(" ");

    // Build the PowerShell command
    const psCommand = `cd '${options.cwd}'; ${envVars}; ${options.command}`;

    // Format window title as "teamName: agentName" if teamName is provided
    const windowTitle = options.teamName
      ? `${options.teamName}: ${options.name}`
      : options.name;

    // Use wt new-window
    const spawnArgs = [
      "new-window",
      "--title", windowTitle,
      "--", psBin, "-NoExit", "-Command", psCommand
    ];

    const result = execCommand(wtBin, spawnArgs);
    if (result.status !== 0) {
      throw new Error(`Windows Terminal spawn-window failed: ${result.stderr}`);
    }

    // Create a synthetic window ID
    const syntheticId = `windows_win_${Date.now()}_${options.name}`;
    return syntheticId;
  }

  /**
   * Set the title of a specific window.
   */
  setWindowTitle(windowId: string, title: string): void {
    // Windows Terminal CLI doesn't support setting window titles post-creation
    // Titles are set at spawn time via --title flag
    // This is a limitation of the wt CLI
  }

  /**
   * Kill/terminate a window.
   */
  killWindow(windowId: string): void {
    if (!windowId?.startsWith("windows_win_")) return;

    // Windows Terminal doesn't provide a direct way to kill windows via CLI
    // This is a limitation of the wt CLI
    // Users would need to close the window manually
  }

  /**
   * Check if a window is still alive/active.
   */
  isWindowAlive(windowId: string): boolean {
    if (!windowId?.startsWith("windows_win_")) return false;

    // Windows Terminal doesn't provide an easy way to check window status via CLI
    // We assume the window is alive for simplicity
    return true;
  }
}
