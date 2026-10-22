/**
 * Tmux Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for tmux terminal multiplexer.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class TmuxAdapter implements TerminalAdapter {
  readonly name = "tmux";

  detect(): boolean {
    // tmux is available if TMUX environment variable is set
    return !!process.env.TMUX;
  }

  private getCurrentPaneId(): string | null {
    const paneId = process.env.TMUX_PANE?.trim();
    return paneId ? paneId : null;
  }

  private getWindowIdForPane(paneId: string | null | undefined): string | null {
    if (!paneId) return null;

    try {
      const result = execCommand("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"]);
      if (result.status !== 0) return null;

      const windowId = result.stdout.trim();
      return windowId || null;
    } catch {
      return null;
    }
  }

  private isPaneUsable(paneId: string | null | undefined): paneId is string {
    if (!paneId) return false;

    try {
      const result = execCommand("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"]);
      return result.status === 0 && result.stdout.trim() === paneId;
    } catch {
      return false;
    }
  }

  private getOriginPaneId(preferredPaneId?: string | null): string | null {
    if (this.isPaneUsable(preferredPaneId)) {
      return preferredPaneId;
    }

    const currentPaneId = this.getCurrentPaneId();
    if (this.isPaneUsable(currentPaneId)) {
      return currentPaneId;
    }

    return null;
  }

  spawn(options: SpawnOptions): string {
    const envArgs = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`);

    const originPaneId = this.getOriginPaneId(options.anchorPaneId);
    if (options.recoveryToken && !originPaneId) {
      throw Object.assign(new Error("No verified lead tmux pane anchor; refusing global target selection"), { spawned: false });
    }
    const tmuxArgs = [
      "split-window",
      "-h", "-dP",
      "-F", "#{pane_id}",
    ];

    if (originPaneId) {
      tmuxArgs.push("-t", originPaneId);
    }

    tmuxArgs.push(
      "-c", options.cwd,
      "env", ...envArgs,
      "sh", "-c", options.command
    );

    const result = execCommand("tmux", tmuxArgs);
    
    if (result.status !== 0) {
      throw Object.assign(new Error(`tmux spawn failed with status ${result.status}: ${result.stderr}`), { spawned: false });
    }

    const newPaneId = result.stdout.trim();
    if (options.recoveryToken) {
      const tagged = execCommand("tmux", ["set-option", "-p", "-t", newPaneId, "@pi-teams-recovery", options.recoveryToken]);
      if (tagged.status !== 0) throw new Error("pane launched but recovery nonce could not be recorded; do not retry blindly");
    }
    const layoutTarget = this.getWindowIdForPane(originPaneId) ?? this.getWindowIdForPane(newPaneId);

    // Apply layout to the exact window that contains the spawned pane so the
    // split always stays anchored to the intended tmux window.
    if (layoutTarget) {
      execCommand("tmux", ["set-window-option", "-t", layoutTarget, "main-pane-width", "60%"]);
      execCommand("tmux", ["select-layout", "-t", layoutTarget, "main-vertical"]);
    } else if (!options.recoveryToken) {
      execCommand("tmux", ["set-window-option", "main-pane-width", "60%"]);
      execCommand("tmux", ["select-layout", "main-vertical"]);
    }

    return newPaneId;
  }

  findRecoveryPane(token: string): string | undefined {
    const result = execCommand("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{@pi-teams-recovery}"]);
    if (result.status !== 0) throw new Error("tmux recovery metadata unavailable");
    const rows = result.stdout.trim().split("\n").map(row => row.split(" "));
    return rows.find(([, value]) => value === token)?.[0];
  }

  kill(paneId: string): "closed" | "absent" | "failed" {
    if (!paneId || paneId.startsWith("iterm_") || paneId.startsWith("zellij_")) {
      return "absent";
    }
    const result = execCommand("tmux", ["kill-pane", "-t", paneId.trim()]);
    if (result.status === 0) return "closed";
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (
      detail.includes("can't find pane")
      || detail.includes("can't find window")
      || detail.includes("can't find session")
      || detail.includes("no such pane")
      || detail.includes("no such window")
      || detail.includes("no such session")
      || detail.includes("session not found")
      || detail.includes("no current session")
    ) {
      return "absent";
    }
    return "failed";
  }

  panePresence(paneId: string): "present" | "missing" | "unknown" {
    // Other adapters use synthetic IDs. Never treat one as a missing tmux pane.
    if (!/^%\d+$/.test(paneId)) return "unknown";
    try {
      const result = execCommand("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
      if (result.status !== 0) return "unknown";
      return result.stdout.trim().split(/\s+/).includes(paneId) ? "present" : "missing";
    } catch {
      return "unknown";
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId || paneId.startsWith("iterm_") || paneId.startsWith("zellij_")) {
      return false; // Not a tmux pane
    }

    return this.isPaneUsable(paneId);
  }

  setTitle(title: string): void {
    try {
      const paneId = this.getCurrentPaneId();
      const args = paneId
        ? ["select-pane", "-t", paneId, "-T", title]
        : ["select-pane", "-T", title];
      execCommand("tmux", args);
    } catch {
      // Ignore errors
    }
  }

  /**
   * tmux does not support spawning separate OS windows
   */
  supportsWindows(): boolean {
    return false;
  }

  /**
   * Not supported - throws error
   */
  spawnWindow(_options: SpawnOptions): string {
    throw new Error("tmux does not support spawning separate OS windows. Use iTerm2 or WezTerm instead.");
  }

  /**
   * Not supported - no-op
   */
  setWindowTitle(_windowId: string, _title: string): void {
    // Not supported
  }

  /**
   * Not supported - no-op
   */
  killWindow(_windowId: string): void {
    // Not supported
  }

  /**
   * Not supported - always returns false
   */
  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
