/**
 * A checklist selection over a known set of ids.
 *
 * The three export dialogs (profiles, environments, JSON Schemas) each carried
 * their own `Set<string>` plus a `toggle` and a `toggleAll` — the same twelve
 * lines, with the same "all selected means clear, otherwise select all"
 * semantics, and the same reseed-on-close.
 *
 * `seed` is what a trigger pre-checks — the per-row export shortcut in
 * `EnvironmentSwitcher` passes one id, the File-menu entry passes none and gets
 * everything. `null` and `undefined` both mean "no seed", since the callers
 * differ on which they use for it.
 *
 * `allIds` is read on every call rather than captured once, so `toggleAll` stays
 * correct if the underlying list changes while the dialog is open (a profile
 * deleted from another window, an environment created). Re-seeding is left to
 * the caller's own open-effect: doing it automatically would undo a click the
 * moment an unrelated store update re-rendered the dialog.
 */

import { useCallback, useMemo, useState } from "react";

export interface MultiSelect {
  selected: Set<string>;
  /** Whether every id in `allIds` is selected. Drives the header checkbox. */
  allSelected: boolean;
  toggle: (id: string) => void;
  /** Select everything, or clear it when everything already is. */
  toggleAll: () => void;
  /**
   * Reset to the seed (or everything, when there is none). Call from the
   * dialog's open/close handler.
   */
  reseed: () => void;
}

export function useMultiSelect(
  allIds: string[],
  seed?: string[] | null,
): MultiSelect {
  const initial = useMemo(() => new Set(seed ?? allIds), [seed, allIds]);
  const [selected, setSelected] = useState<Set<string>>(initial);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = selected.size === allIds.length && allIds.length > 0;

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
  }, [allIds]);

  const reseed = useCallback(() => setSelected(new Set(seed ?? allIds)), [
    seed,
    allIds,
  ]);

  return { selected, allSelected, toggle, toggleAll, reseed };
}
