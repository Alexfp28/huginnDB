/**
 * Pure transitions over a table browse's multi-column sort (`SortSpec[]`,
 * `sort[0]` the primary key). The sort is server-side state — it becomes the
 * `ORDER BY` / `sort()` of `fetch_table_data` — so every gesture that changes
 * it, from any surface, goes through one of these.
 *
 * There are four surfaces and two semantics, deliberately:
 *
 * - **Replace** — a plain header click ({@link nextSort}) and "Sort by this
 *   field" in the list view's context menu ({@link sortOnly}). Both answer
 *   "order the rows by *this*", so what was there before goes.
 * - **Build** — Ctrl/Cmd+header click ({@link nextSort} with `additive`) and
 *   the toolbar's "Sort by" menu ({@link upsertSortLevel}). Both add a level
 *   (or retarget one in place) without disturbing the others.
 *
 * The chips that show the sort in both view modes only ever flip or drop a
 * level ({@link toggleSortLevel}, {@link removeSortLevel}); they never reorder,
 * because a rank that moves under the pointer is harder to read than one you
 * rebuild on purpose.
 */

import type { SortSpec } from "@/types";

/**
 * Compute the next sort state from a header click.
 *
 * - **Plain click** (`additive === false`): collapse to a single key on
 *   `column`, cycling its direction ASC → DESC → none (clicking a third time,
 *   or while already multi-sorted, resets to that one column ascending).
 * - **Ctrl/Cmd+click** (`additive === true`): keep the existing keys and add
 *   `column` as the lowest-precedence level (ASC); if it's already present,
 *   cycle it ASC → DESC → removed in place.
 */
export function nextSort(
  current: SortSpec[],
  column: string,
  additive: boolean,
): SortSpec[] {
  const existing = current.find((s) => s.column === column);
  if (additive) {
    if (!existing) return [...current, { column, desc: false }];
    if (!existing.desc)
      return current.map((s) =>
        s.column === column ? { ...s, desc: true } : s,
      );
    return current.filter((s) => s.column !== column);
  }
  // Plain click: a single-key cycle, ignoring any multi-sort already active.
  if (!existing || current.length > 1) return [{ column, desc: false }];
  if (!existing.desc) return [{ column, desc: true }];
  return [];
}

/** Order by `column` alone, in the given direction — the list view's "Sort
 *  ascending/descending by this field". */
export function sortOnly(column: string, desc: boolean): SortSpec[] {
  return [{ column, desc }];
}

/**
 * Set `column`'s direction without touching the other levels: in place when it
 * is already sorted (its rank is kept), appended as the lowest-precedence level
 * otherwise. What the toolbar's "Sort by" menu does.
 */
export function upsertSortLevel(
  current: SortSpec[],
  column: string,
  desc: boolean,
): SortSpec[] {
  if (current.some((s) => s.column === column)) {
    return current.map((s) => (s.column === column ? { column, desc } : s));
  }
  return [...current, { column, desc }];
}

/** Flip one level's direction in place. A column that isn't sorted is left
 *  alone rather than added — a chip only exists for a level that does. */
export function toggleSortLevel(
  current: SortSpec[],
  column: string,
): SortSpec[] {
  return current.map((s) =>
    s.column === column ? { column, desc: !s.desc } : s,
  );
}

/** Drop one level; the ones after it move up a rank. */
export function removeSortLevel(
  current: SortSpec[],
  column: string,
): SortSpec[] {
  return current.filter((s) => s.column !== column);
}

/**
 * Where `column` sits in the sort, for a field's context menu and the "Sort by"
 * menu's rows: its direction and 1-based rank, or `null` when it isn't sorted.
 */
export function sortLevelOf(
  current: readonly SortSpec[],
  column: string,
): { desc: boolean; rank: number } | null {
  const i = current.findIndex((s) => s.column === column);
  return i < 0 ? null : { desc: current[i].desc, rank: i + 1 };
}
