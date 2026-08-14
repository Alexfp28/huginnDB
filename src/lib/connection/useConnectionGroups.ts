/**
 * Shared collapse/expand logic for the connection group tree, used by every
 * surface that renders grouped connections (the File menu, the connections
 * manager dialog, the environment's Schema tree, the status-bar switcher).
 *
 * The `ui.connectionGroupExpandMode` preference decides the *initial* state
 * a surface mounts with:
 *   - "remember"  → seed from the persisted `collapsedConnectionGroups` set.
 *   - "expanded"  → groups start open.
 *   - "collapsed" → groups start folded.
 *
 * From then on every toggle lives in a per-hook-instance session override —
 * in every mode, including "remember" — so surfaces mounted at the same time
 * (e.g. the environment's tree behind an already-open connections manager
 * dialog) never reshape each other: folding a group in the dialog used to
 * fold it live in the tree too, because both read the same persisted value
 * on every render. "remember" toggles still write through to disk so the
 * *next* surface to mount (including this one, next launch) picks up the
 * latest arrangement — they just don't retroactively touch a surface that's
 * already on screen.
 */

import { useCallback, useState } from "react";
import { usePreferences } from "@/stores/preferences/preferences";

export interface GroupCollapse {
  /** Whether the named group is currently collapsed. */
  isCollapsed: (name: string) => boolean;
  /** Flip the named group's collapsed state (persisted only in "remember"). */
  toggle: (name: string) => void;
}

export function useConnectionGroupCollapse(): GroupCollapse {
  const mode = usePreferences((s) => s.prefs.ui.connectionGroupExpandMode);
  const updateUi = usePreferences((s) => s.updateUi);

  // Session-local overrides, seeded once at mount from the persisted
  // "remember" set. Deliberately NOT a live subscription to
  // `collapsedConnectionGroups` — see the module doc.
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => {
    if (mode !== "remember") return {};
    const seed: Record<string, boolean> = {};
    for (const name of usePreferences.getState().prefs.ui
      .collapsedConnectionGroups) {
      seed[name] = true;
    }
    return seed;
  });

  const isCollapsed = useCallback(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return mode === "collapsed";
    },
    [mode, overrides],
  );

  const toggle = useCallback(
    (name: string) => {
      setOverrides((prev) => {
        const current = name in prev ? prev[name] : mode === "collapsed";
        const next = { ...prev, [name]: !current };
        if (mode === "remember") {
          const collapsedGroups =
            usePreferences.getState().prefs.ui.collapsedConnectionGroups;
          const nowCollapsed = !current;
          updateUi({
            collapsedConnectionGroups: nowCollapsed
              ? [...collapsedGroups, name]
              : collapsedGroups.filter((g) => g !== name),
          });
        }
        return next;
      });
    },
    [mode, updateUi],
  );

  return { isCollapsed, toggle };
}
