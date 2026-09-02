/**
 * "It saved" — a one-shot pulse on the cell a write just landed in.
 *
 * The grid had no success feedback at all. Committing an inline edit ran the
 * `UPDATE`, refetched, and left the cell looking exactly as it did while you
 * were typing; the only way to learn that a write had failed was that a toast
 * appeared, so silence had to be read as success. On a database client that is
 * the wrong default — "did that actually go through?" is the first question
 * after an edit, and the app was answering it with nothing.
 *
 * `animate-brand-flash` is what answers it, and it is worth noting that the
 * token was already there: the visual brief asked for "a short blue pulse on a
 * completed action", `tailwind.config.js` defines it as a single 520ms
 * iteration that leaves nothing behind, and until now the settings screen's
 * scroll-to-preference highlight was its only consumer in the whole app. This
 * is the animation being used for the thing it was designed for.
 *
 * **Keyed by row key, never by the values array or a display index.** The mark
 * is set *after* the save resolves, and every save path refetches on the way
 * through, so by the time this runs the row's values array has been replaced by
 * a new object from the fresh page (gotcha #7's concern, one step further on).
 * The primary-key tuple is the only identity that survives that. A grid with no
 * key — a query result with no identity — simply does not flash, which is
 * correct rather than a gap: it is not editable either.
 *
 * One deliberate non-feature: editing a primary-key column changes the row's
 * own key, so the flash lands on a key that no longer exists and nothing
 * pulses. Chasing that would mean guessing which new row used to be the old
 * one, and the write is visibly reflected in the reordered grid anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Matches `animation: brand-flash 520ms` in `tailwind.config.js`, plus a little
 * slack so the class is not pulled while the last frame is still painting.
 * Longer than the animation is harmless (the pulse has already ended); shorter
 * truncates it.
 */
const FLASH_MS = 700;

export interface SavedCellFlash {
  /** The cell currently pulsing, or `null`. */
  flashed: { rowKey: string; column: string } | null;
  /** Mark a cell as just-saved. A `null` key is ignored (unkeyed grid). */
  markSaved: (rowKey: string | null, column: string) => void;
}

export function useSavedCellFlash(): SavedCellFlash {
  const [flashed, setFlashed] = useState<SavedCellFlash["flashed"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The timeout outlives the component if the tab is closed mid-flash, and
  // would then set state on an unmounted tree.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const markSaved = useCallback((rowKey: string | null, column: string) => {
    if (!rowKey) return;
    if (timer.current) clearTimeout(timer.current);
    setFlashed({ rowKey, column });
    timer.current = setTimeout(() => {
      setFlashed(null);
      timer.current = null;
    }, FLASH_MS);
  }, []);

  return { flashed, markSaved };
}
