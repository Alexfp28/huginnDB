/**
 * Shared collapse/expand logic for the connection group tree, used by every
 * surface that renders grouped connections (the File menu, the connections
 * manager rail, the status-bar switcher).
 *
 * The `ui.connectionGroupExpandMode` preference decides the *default* state:
 *   - "remember"  → defer to the persisted `collapsedConnectionGroups` set,
 *                   toggling writes back to disk (the historical behaviour).
 *   - "expanded"  → groups start open; toggles live in per-surface session
 *                   state only (nothing persisted).
 *   - "collapsed" → groups start folded; toggles live in session state.
 *
 * Keeping the session overrides local to each hook instance is deliberate:
 * in the forced modes a fold in one surface shouldn't silently reshape the
 * others, and the persisted "remember" set stays clean of transient toggles.
 */

import { useCallback, useState } from "react";
import { usePreferences } from "@/stores/preferences";

export interface GroupCollapse {
  /** Whether the named group is currently collapsed. */
  isCollapsed: (name: string) => boolean;
  /** Flip the named group's collapsed state (persisted only in "remember"). */
  toggle: (name: string) => void;
}

export function useConnectionGroupCollapse(): GroupCollapse {
  const mode = usePreferences((s) => s.prefs.ui.connectionGroupExpandMode);
  const collapsedGroups = usePreferences(
    (s) => s.prefs.ui.collapsedConnectionGroups,
  );
  const updateUi = usePreferences((s) => s.updateUi);

  // Session-only overrides for the forced ("expanded"/"collapsed") modes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isCollapsed = useCallback(
    (name: string) => {
      if (mode === "remember") return collapsedGroups.includes(name);
      if (name in overrides) return overrides[name];
      return mode === "collapsed";
    },
    [mode, collapsedGroups, overrides],
  );

  const toggle = useCallback(
    (name: string) => {
      if (mode === "remember") {
        const collapsed = collapsedGroups.includes(name);
        updateUi({
          collapsedConnectionGroups: collapsed
            ? collapsedGroups.filter((g) => g !== name)
            : [...collapsedGroups, name],
        });
        return;
      }
      setOverrides((prev) => {
        const current = name in prev ? prev[name] : mode === "collapsed";
        return { ...prev, [name]: !current };
      });
    },
    [mode, collapsedGroups, updateUi],
  );

  return { isCollapsed, toggle };
}
