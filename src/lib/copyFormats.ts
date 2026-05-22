/**
 * Clipboard-friendly serialisers for grid rows.
 *
 * The data grid's right-click menu offers a "Copy as ▸" submenu that
 * uses these helpers to render the currently-selected row in different
 * shapes — JSON, a SQL `INSERT`, or a SQL `UPDATE`. The output is
 * **never** executed by the app; it's purely for the user to paste
 * elsewhere. Best-effort escaping is therefore acceptable: we quote
 * strings safely enough for a paste-and-tweak workflow, but a malicious
 * value would not bypass anything because nothing in the app evaluates
 * the result.
 *
 * Driver awareness comes in only at the identifier-quoting layer: MySQL
 * uses backticks (`` ` ``), Postgres / SQLite use double quotes (`"`).
 * Reusing this distinction keeps the snippets paste-ready against the
 * source database without manual edits.
 */

import type { CellValue, ColumnMeta, Driver } from "@/types";

/** Render a value as its plain string projection (used when serialising
 *  to JSON-incompatible payloads). */
function plain(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Quote an identifier (table or column name) for the target driver.
 *
 * Doubles any embedded quote character, which is the standard escape in
 * SQL identifier syntax for every supported driver. We don't try to
 * detect "already-quoted" inputs — callers pass raw catalog names.
 */
export function quoteIdent(driver: Driver | undefined, name: string): string {
  if (driver === "mysql") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  // Postgres + SQLite both accept ANSI double-quoted identifiers.
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Quote a scalar value as a SQL literal. Numbers and booleans inline
 * as-is, strings get single-quoted with `''` escapes, NULL stays NULL.
 *
 * JSON / object values are stringified first; this is intentional —
 * Postgres accepts a JSON literal as a quoted string thanks to implicit
 * casts in most contexts. The user can refine if needed.
 */
export function sqlLiteral(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * JSON object keyed by column name. Pretty-printed (2-space indent)
 * because the typical destination is a doc / chat message where
 * readability matters more than transport size. `null` columns are
 * preserved; we do not drop them (would change shape and lose intent).
 */
export function toJson(
  rowValues: CellValue[],
  columns: ColumnMeta[],
): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i].name] = jsonSafe(rowValues[i]);
  }
  return JSON.stringify(obj, null, 2);
}

/**
 * Normalise a cell value into something `JSON.stringify` can represent
 * without throwing. We currently only worry about `BigInt` (rare but
 * possible if the backend ever switches to bigint-native serialisation);
 * everything else passes through unchanged.
 */
function jsonSafe(v: CellValue): unknown {
  if (typeof v === "bigint") return (v as bigint).toString();
  return v;
}

/**
 * A SQL `INSERT INTO … (cols) VALUES (lits);` snippet for the row.
 *
 * If `tableName` is missing we fall back to a placeholder `<table>` so
 * the snippet remains structurally valid for the user to fill in — this
 * matters for query-result rows where the source table isn't known.
 */
export function toSqlInsert(
  rowValues: CellValue[],
  columns: ColumnMeta[],
  driver: Driver | undefined,
  tableName: string | undefined,
  schema: string | undefined,
): string {
  const tbl = qualifiedTable(driver, schema, tableName);
  const cols = columns.map((c) => quoteIdent(driver, c.name)).join(", ");
  const vals = rowValues.map(sqlLiteral).join(", ");
  return `INSERT INTO ${tbl} (${cols}) VALUES (${vals});`;
}

/**
 * A SQL `UPDATE … SET … WHERE pk = lit;` snippet for the row.
 *
 * Every PK column is excluded from the `SET` clause (updating a row's
 * primary key from a copy-paste is almost never the user's intent) and
 * AND-joined in the `WHERE` clause so the snippet stays safe on
 * composite-PK tables — emitting only the first PK column there would
 * silently fan the UPDATE out across every row sharing that leading
 * value, exactly the corruption the cell-save path used to suffer. If
 * the row has no known PK columns the snippet falls back to
 * `WHERE <pk> = <value>` so the user fixes it before executing.
 */
export function toSqlUpdate(
  rowValues: CellValue[],
  columns: ColumnMeta[],
  driver: Driver | undefined,
  tableName: string | undefined,
  schema: string | undefined,
  pkColumnNames: string[] | undefined,
): string {
  const tbl = qualifiedTable(driver, schema, tableName);
  const pkSet = new Set(pkColumnNames ?? []);
  const pkIndices = (pkColumnNames ?? [])
    .map((name) => columns.findIndex((c) => c.name === name))
    .filter((i) => i >= 0);

  const setPairs = columns
    .map((c, i) => {
      if (pkSet.has(c.name)) return null;
      return `${quoteIdent(driver, c.name)} = ${sqlLiteral(rowValues[i])}`;
    })
    .filter((s): s is string => s !== null)
    .join(", ");

  let whereClause: string;
  if (pkIndices.length > 0) {
    whereClause = pkIndices
      .map(
        (i) =>
          `${quoteIdent(driver, columns[i].name)} = ${sqlLiteral(rowValues[i])}`,
      )
      .join(" AND ");
  } else {
    whereClause = "<pk> = <value>";
  }
  return `UPDATE ${tbl} SET ${setPairs} WHERE ${whereClause};`;
}

/**
 * Build the qualified table reference for the snippet: `"schema"."table"`
 * when both are known, `"table"` when only the table is, `<table>` as a
 * paste-ready placeholder otherwise.
 */
function qualifiedTable(
  driver: Driver | undefined,
  schema: string | undefined,
  table: string | undefined,
): string {
  if (!table) return "<table>";
  if (schema && schema.length > 0) {
    return `${quoteIdent(driver, schema)}.${quoteIdent(driver, table)}`;
  }
  return quoteIdent(driver, table);
}

// Re-export the plain projector so callers (e.g. CellPreview) can share
// the same string contract used for clipboard text without re-implementing it.
export { plain as plainText };
