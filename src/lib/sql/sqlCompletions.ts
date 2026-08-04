/**
 * Build the Monaco completion list for the SQL editor.
 *
 * Pure data transform: takes the catalogue we have (tables, columns,
 * keywords) and emits the kind/detail/sortText triples Monaco needs.
 * Keeping this out of the component file makes it trivial to test and
 * to evolve independently of the editor wiring.
 *
 * Ordering strategy uses `sortText` prefixes:
 *
 *   "1_<name>"  — tables   (most specific, user typed something concrete)
 *   "2_<name>"  — columns
 *   "3_<name>"  — keywords (last resort, abundant matches)
 *
 * Monaco sorts lexicographically by `sortText` before falling back to
 * label, so the prefix gives us deterministic ranking without fighting
 * the editor's built-in fuzzy match.
 *
 * The `kind` numbers are Monaco's `CompletionItemKind` enum, but we keep
 * the enum out of this file so it remains a plain-TS module (easier to
 * test in isolation, no `monaco-editor` import side-effects). Callers
 * map the string `kind` to the real enum at the use site.
 */

import type { ColumnInfo, TableInfo } from "@/types";

export type CompletionKind = "table" | "column" | "keyword";

export interface CompletionSuggestion {
  /** Token inserted on accept. */
  label: string;
  kind: CompletionKind;
  /** Sort key; prefixed by kind tier. */
  sortText: string;
  /** Right-aligned secondary text in the completion popup. */
  detail: string;
}

/**
 * Inputs collected from the schema store (tables + columns indexed
 * by `${schema}.${table}` like the rest of the app) plus the keyword
 * catalogue from [[keywordsFor]].
 */
export interface CompletionsInput {
  tables: ReadonlyArray<TableInfo>;
  /** Map keyed by `${schema}.${table}` — same shape as `useSchema.byConnection[id].columns`. */
  columns: Readonly<Record<string, ReadonlyArray<ColumnInfo>>>;
  keywords: ReadonlyArray<string>;
}

/**
 * Render the suggestion list. We deduplicate column names (a column
 * named `id` shows up on most tables; surfacing each one would clutter
 * the popup); the `detail` for a deduped column lists how many tables
 * carry it so the user still gets some context.
 */
export function buildCompletions(input: CompletionsInput): CompletionSuggestion[] {
  const out: CompletionSuggestion[] = [];

  // Tables: include schema in `detail` so users disambiguate manually
  // when two schemas carry the same table name.
  for (const t of input.tables) {
    out.push({
      label: t.name,
      kind: "table",
      sortText: `1_${t.name}`,
      detail: t.schema ? `table — ${t.schema}` : "table",
    });
  }

  // Columns: dedupe by name. We could expose every (table, column) pair
  // but it bloats the popup; collapsing keeps the list scannable.
  const colCounts = new Map<string, { count: number; sample: ColumnInfo }>();
  for (const cols of Object.values(input.columns)) {
    for (const c of cols) {
      const existing = colCounts.get(c.name);
      if (existing) {
        existing.count++;
      } else {
        colCounts.set(c.name, { count: 1, sample: c });
      }
    }
  }
  for (const [name, info] of colCounts) {
    const detail =
      info.count === 1
        ? `column — ${info.sample.data_type}`
        : `column · ${info.count} tables`;
    out.push({
      label: name,
      kind: "column",
      sortText: `2_${name}`,
      detail,
    });
  }

  // Keywords: pure tokens, no per-token detail beyond the kind label.
  for (const kw of input.keywords) {
    out.push({
      label: kw,
      kind: "keyword",
      sortText: `3_${kw}`,
      detail: "keyword",
    });
  }

  return out;
}
