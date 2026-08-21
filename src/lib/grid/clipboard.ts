/**
 * Write `text` to the system clipboard, swallowing a denial.
 *
 * Failures are deliberately silent. The webview can refuse the write (no
 * secure context, a permission the user declined), and there is nothing
 * useful to say about it: the user pressed Ctrl+C, nothing landed in their
 * clipboard, and the next paste tells them so more clearly than a toast
 * would. The paste half (`navigator.clipboard.readText`) follows the same
 * convention at its call site.
 *
 * Shared rather than inlined because the grid copies from three places — the
 * cell context menu, the bulk "Copy N rows as ▸" menu, and the Ctrl+C chord —
 * which reach it through two different paths (`rowCallbacksRef` for the
 * memoised rows, the keyboard handler for the chord).
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // See above: visually obvious to the user, nothing to surface.
  }
}
