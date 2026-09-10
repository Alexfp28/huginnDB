/**
 * Shaping a tool result for the panel, so a claim can be checked against what
 * was actually read.
 *
 * # Why the panel shows the payload when the Console does not
 *
 * The Console records a tool call's *size* and row count and deliberately never
 * its content: it is a log the user can copy out of, so writing row data into
 * it would undo the metadata-only guarantee it exists to make checkable.
 * A tool card in the transcript is the opposite case. The rows are already on
 * this machine, the user asked for them, and the model is about to summarise
 * them — badly, sometimes, because a model of the size this feature is built
 * around does hallucinate. Putting the evidence one click under the claim is
 * the difference between trusting the answer and checking it.
 *
 * Pure, so the shaping is tested without a model or a database. The renderer
 * ([`ToolCallCard`]) only chooses between a table and a `<pre>`.
 */

/** A row-shaped tool result, ready to render. */
export interface ResultTable {
  columns: string[];
  /** Cell text, already flattened and truncated by [`cellText`]. */
  rows: string[][];
  /** The tool reply said it dropped rows — the cap, or the size budget. */
  truncated: boolean;
  /** The table's real row count, when `browse_table` asked for it. */
  total?: number;
}

/**
 * Characters of one cell shown before it is elided.
 *
 * Generous on purpose: in a configuration database the interesting columns are
 * exactly the ones holding a JSON document, and eliding at 40 characters would
 * show every row as `{"enabled": true, "mode": "…`.
 */
export const MAX_CELL_CHARS = 300;

/** Characters of a non-row result shown before it is elided. */
export const MAX_JSON_CHARS = 4000;

/**
 * One cell as text.
 *
 * JSON stays JSON — a nested object is serialised rather than rendered as
 * `[object Object]`, which is what a naive `String(value)` produces and which
 * is worse than useless on a column full of documents.
 */
export function cellText(value: unknown, max = MAX_CELL_CHARS): string {
  const text =
    value === null || value === undefined
      ? "NULL"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return elide(text ?? "NULL", max);
}

/** `text`, cut at `max` with an ellipsis that says it was cut. */
export function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The result as a table, or `null` when it is not row-shaped.
 *
 * The shape is `QueryResult`'s (`commands::query`): `columns` carry a `name`,
 * `rows` are arrays aligned to them. `describe_table` and the list tools return
 * other shapes, and those render as JSON rather than being coerced into a grid
 * that would misrepresent them.
 */
export function asTable(result: unknown): ResultTable | null {
  if (!result || typeof result !== "object") return null;
  const shape = result as {
    columns?: unknown;
    rows?: unknown;
    truncated?: unknown;
    total?: unknown;
  };
  if (!Array.isArray(shape.columns) || !Array.isArray(shape.rows)) return null;
  const columns = shape.columns.map((column) =>
    typeof column === "string"
      ? column
      : String((column as { name?: unknown })?.name ?? ""),
  );
  return {
    columns,
    rows: shape.rows.map((row) =>
      Array.isArray(row)
        ? row.map((cell) => cellText(cell))
        : // A row that is an object rather than an array: read it by column
          // name, so a driver that shapes rows that way still renders.
          columns.map((column) =>
            cellText((row as Record<string, unknown>)?.[column]),
          ),
    ),
    truncated: shape.truncated === true,
    total: typeof shape.total === "number" ? shape.total : undefined,
  };
}

/** A non-row result as indented JSON, bounded. */
export function previewJson(result: unknown, max = MAX_JSON_CHARS): string {
  try {
    return elide(JSON.stringify(result, null, 2) ?? String(result), max);
  } catch {
    // A cyclic or unserialisable payload cannot arrive over Tauri's IPC, but
    // the renderer must not be the thing that proves it.
    return elide(String(result), max);
  }
}

/**
 * The statement a tool call ran, if the call was one that takes free text.
 *
 * Used by the card's "open in editor" action: the read the assistant made is
 * the one the user most often wants to keep — to see it in a grid, to widen
 * it, or to check that the answer above it is true.
 */
export function statementOf(name: string, args: unknown): string | null {
  if (name !== "run_query" || !args || typeof args !== "object") return null;
  const sql = (args as { sql?: unknown }).sql;
  return typeof sql === "string" && sql.trim() ? sql : null;
}
