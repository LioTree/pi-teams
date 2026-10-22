import type { PanePresence, TerminalAdapter } from "./terminal-adapter";

/** Observe only panes addressable by the current tmux adapter. A missing lead
 * anchor suggests collective terminal loss, not a member-specific hide action.
 * The boolean fallback supports adapters/fixtures predating tri-state queries;
 * the real tmux adapter always uses its explicit successful-list result.
 */
export function observeTmuxPane(
  terminal: TerminalAdapter | null,
  paneId: string | undefined,
  anchorPaneId?: string,
): PanePresence {
  if (terminal?.name !== "tmux" || !paneId) return "unknown";
  const query = (id: string): PanePresence => terminal.panePresence?.(id)
    ?? (terminal.isAlive(id) ? "present" : "missing");
  const presence = query(paneId);
  if (presence === "missing" && anchorPaneId && query(anchorPaneId) !== "present") return "unknown";
  return presence;
}
