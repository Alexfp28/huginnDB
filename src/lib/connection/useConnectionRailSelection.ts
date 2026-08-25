/**
 * The connection rail's multi-selection: which rows are checked for a bulk
 * delete, and the OS-style gestures that build that set.
 *
 * Owns its state (four callbacks over one `Set` and one anchor ref), so the rail
 * hands it identity props rather than a live copy of itself — the seam gotcha
 * #28 calls an *owning* one.
 *
 * Two rules that are easy to get wrong and were both bugs in the inline version
 * this replaces:
 *
 * 1. **Selection is not navigation.** A plain click opens a profile in the
 *    editor and *clears* the selection; only a checkbox, Ctrl/Cmd-click or
 *    Shift-click adds to it. The old code set `selectedIds = {id}` on every
 *    plain click and hid the bulk bar until two rows were in it, which is why
 *    the bar could only ever be revealed by an explicit gesture anyway. Making
 *    that explicit is what lets the bar appear from *one* checked row without
 *    flashing on every click.
 * 2. **Protected ids can never enter the set.** A profile a shared origin
 *    publishes is refused by the backend's bulk delete, so letting it be checked
 *    would offer an action that silently does nothing. Every one of the four
 *    entry points filters against `protectedIds` — by construction, not by each
 *    caller remembering to.
 */

import { useCallback, useMemo, useRef, useState } from "react";

export interface RailSelection {
  /** Ids checked for a bulk action. Unrelated to which profile is being edited. */
  checked: Set<string>;
  /** Checkbox and Ctrl/Cmd-click: flip one row. No-op on a protected id. */
  toggle: (id: string) => void;
  /**
   * Shift-click: add every row between the anchor and `id`.
   *
   * `visibleIds` is passed in per call because it is the *collapse-aware* list —
   * a row inside a folded group is not between two visible rows. The
   * select-all domain is a different list on purpose (`RailSection.ids`).
   */
  extendTo: (id: string, visibleIds: string[]) => void;
  /** Header checkbox: check all of `ids`, or clear them if all are already in. */
  toggleAll: (ids: string[]) => void;
  clear: () => void;
}

export function useConnectionRailSelection(
  protectedIds: Set<string>,
): RailSelection {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  const allowed = useCallback(
    (id: string) => !protectedIds.has(id),
    [protectedIds],
  );

  const toggle = useCallback(
    (id: string) => {
      if (!allowed(id)) return;
      anchorRef.current = id;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [allowed],
  );

  const extendTo = useCallback(
    (id: string, visibleIds: string[]) => {
      const anchor = anchorRef.current;
      if (!anchor) {
        toggle(id);
        return;
      }
      const from = visibleIds.indexOf(anchor);
      const to = visibleIds.indexOf(id);
      if (from === -1 || to === -1) return;
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const range = visibleIds.slice(lo, hi + 1).filter(allowed);
      setChecked((prev) => new Set([...prev, ...range]));
    },
    [allowed, toggle],
  );

  const toggleAll = useCallback(
    (ids: string[]) => {
      const selectable = ids.filter(allowed);
      if (selectable.length === 0) return;
      setChecked((prev) => {
        const next = new Set(prev);
        // "All of them are already in" is what makes this a toggle rather than
        // two separate controls.
        if (selectable.every((id) => next.has(id))) {
          for (const id of selectable) next.delete(id);
        } else {
          for (const id of selectable) next.add(id);
        }
        return next;
      });
    },
    [allowed],
  );

  const clear = useCallback(() => {
    anchorRef.current = null;
    setChecked((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  return useMemo(
    () => ({ checked, toggle, extendTo, toggleAll, clear }),
    [checked, toggle, extendTo, toggleAll, clear],
  );
}
