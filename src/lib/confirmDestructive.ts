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

import { usePreferences } from "@/stores/preferences";

export function confirmDestructive(message: string): boolean {
  const enabled = usePreferences.getState().prefs.ui.confirmDestructive;
  if (!enabled) return true;
  return window.confirm(message);
}
