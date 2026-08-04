/**
 * Gate a destructive action behind the user's `ui.confirmDestructive`
 * preference.
 *
 * When the preference is enabled (the default) this defers to the native
 * `window.confirm` dialog and returns its result. When the user has turned
 * confirmations off, it returns `true` immediately so the caller proceeds
 * without prompting.
 *
 * Read from the store imperatively (not via a hook) so it can be called from
 * event handlers and non-component code paths alike.
 *
 * NOTE: `DROP TABLE` (in `SchemaExplorer`) uses its own dedicated, always-on
 * confirmation dialog rather than this preference-gated helper — dropping a
 * table is a higher safety tier, so it is confirmed regardless of this toggle.
 */

import { usePreferences } from "@/stores/preferences/preferences";

export function confirmDestructive(message: string): boolean {
  const enabled = usePreferences.getState().prefs.ui.confirmDestructive;
  if (!enabled) return true;
  return window.confirm(message);
}

/**
 * Confirm an **irreversible** action, ignoring `ui.confirmDestructive`.
 *
 * The preference exists so a user who knows what they are doing isn't nagged
 * about actions they can undo or redo — deleting a row they can re-insert,
 * emptying a table they can repopulate. It was never meant to be a blanket
 * "never ask me anything", and reading it that way turns one stale toggle into
 * silent data loss.
 *
 * Use this instead whenever the thing being destroyed exists nowhere else and
 * cannot be reconstructed from the database: an environment's tabs and pane
 * layout, a registered origin's stored passphrase. `DROP TABLE` already had its
 * own always-on dialog for the same reason; this is that rule made shared
 * instead of re-implemented per call site.
 *
 * If in doubt about which helper an action wants, ask: *could the user get this
 * back?* If the answer is no, it belongs here.
 */
export function confirmIrreversible(message: string): boolean {
  return window.confirm(message);
}
