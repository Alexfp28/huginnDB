/**
 * Arrow-key navigation over a flat list of rows in an overlay.
 *
 * Owns the three pieces the command palette and the tab switcher each had their
 * own copy of: the highlighted index, keeping it in bounds as the result set
 * shrinks, and scrolling the highlighted row into view. Rows must carry
 * `data-index={i}` inside the element `listRef` is attached to.
 *
 * `wrap` is a parameter rather than a decision made here because the two
 * consumers genuinely differ: the command palette wraps (a long result list is
 * a ring you spin through), while the tab switcher clamps (its list is short
 * enough to see whole, and wrapping past the end reads as a jump). Collapsing
 * them onto one behaviour would be a regression for whichever lost.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";

export interface ListNavigation {
  highlight: number;
  setHighlight: Dispatch<SetStateAction<number>>;
  /** Attach to the scrolling container holding the `data-index` rows. */
  listRef: RefObject<HTMLDivElement>;
  /**
   * Handle ArrowUp/ArrowDown, preventing the default caret move. Returns
   * whether the key was consumed, so the caller can `return` early and keep its
   * own Enter/Delete/Tab handling flat.
   */
  handleArrows: (event: KeyboardEvent) => boolean;
}

export function useListNavigation(
  count: number,
  { wrap = false }: { wrap?: boolean } = {},
): ListNavigation {
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlight in bounds as the result set shrinks — otherwise Enter
  // silently does nothing, because it resolves a row past the end.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, count - 1)));
  }, [count]);

  // Keep the highlighted row in view during arrow-key navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, count]);

  const handleArrows = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) =>
          // `Math.max(0, …)` matters only for an empty list, where
          // `count - 1` is -1: both index into nothing, but a negative
          // highlight is a footgun for any future consumer that trusts it.
          wrap
            ? count
              ? (h + 1) % count
              : 0
            : Math.max(0, Math.min(h + 1, count - 1)),
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) =>
          wrap ? (count ? (h - 1 + count) % count : 0) : Math.max(h - 1, 0),
        );
        return true;
      }
      return false;
    },
    [count, wrap],
  );

  return { highlight, setHighlight, listRef, handleArrows };
}
