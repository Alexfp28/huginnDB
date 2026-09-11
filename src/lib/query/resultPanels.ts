/**
 * Turn a batch run's per-statement outcomes into the flat list of result
 * panels the query tab shows.
 *
 * Pure, and out of the component for the usual reason: the interesting part is
 * the flattening, and nothing tested `BatchResult` consumption at all before
 * the results area grew past a single grid. Three things it decides:
 *
 * - **Which statements get a panel.** Only those that returned a result set.
 *   A write's affected-row count and the statement that stopped the batch are
 *   reported in the summary line instead, because an empty grid is a worse
 *   answer than a sentence.
 * - **Panel identity.** `${statementIndex}:${setIndex}` — stable across a
 *   re-render, and distinct even when one statement produced several sets.
 * - **What the label says.** `statement` is 1-based because the summary above
 *   counts that way; `set` is non-null only when the statement produced more
 *   than one set, so the common case reads `#2` rather than a pointless `#2.1`.
 */

import type { QueryResult, StmtOutcome } from "@/types";

/** One result set on screen, and the identity the tab strip selects by. */
export interface ResultPanel {
  /** Stable key: statement index, then set ordinal within that statement. */
  key: string;
  /** 1-based statement number, matching the batch summary above. */
  statement: number;
  /** 1-based ordinal *within* the statement, or `null` when it produced one
   *  result set — which is every driver but SQL Server, whose single T-SQL
   *  statement can genuinely return several. */
  set: number | null;
  result: QueryResult;
}

/** Flatten a batch's statements into one panel per result set, in order. */
export function panelsFromBatch(
  statements: ReadonlyArray<StmtOutcome>,
): ResultPanel[] {
  return statements.flatMap((stmt) =>
    stmt.results.map((result, i) => ({
      key: `${stmt.index}:${i}`,
      statement: stmt.index + 1,
      set: stmt.results.length > 1 ? i + 1 : null,
      result,
    })),
  );
}
