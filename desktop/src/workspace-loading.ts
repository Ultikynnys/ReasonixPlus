export function areWorkspacesLoaded(
  expected: Set<string> | null,
  initialized: Set<string>,
): boolean {
  if (!expected) return false;
  for (const id of expected) {
    if (!initialized.has(id)) return false;
  }
  return true;
}

/** Whether the splash may lift: the tab the user is actually shown has acked.
 *  Requiring every restored tab multiplied the splash by the tab count, while the
 *  backend already emits `$workspace_initialized` per tab and only awaits the
 *  focused one's build. Without a known focused tab, every tab must be ready. */
export function isWorkspaceRevealReady(
  expected: Set<string> | null,
  initialized: Set<string>,
  activeTabId: string | null,
): boolean {
  if (!expected) return false;
  if (activeTabId && expected.has(activeTabId)) return initialized.has(activeTabId);
  return areWorkspacesLoaded(expected, initialized);
}
