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
 * NOTE: high-friction guards that ask the user to *type* a name (e.g. the
 * `DROP TABLE` confirmation in `SchemaExplorer`) deliberately do NOT route
 * through here — dropping a table is a different safety tier and stays gated
 * regardless of this preference.
 */

import { usePreferences } from "@/stores/preferences";

export function confirmDestructive(message: string): boolean {
  const enabled = usePreferences.getState().prefs.ui.confirmDestructive;
  if (!enabled) return true;
  return window.confirm(message);
}
