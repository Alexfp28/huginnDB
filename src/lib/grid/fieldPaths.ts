/**
 * The field catalogue the filter row's field picker offers — top-level columns
 * plus, for MongoDB, the **nested paths** found inside the documents on screen.
 *
 * Why this exists: `infer_columns` (Rust, `db::mongo::schema`) samples a
 * collection and reports its *top-level* fields, because that list is also the
 * data grid's column list and the structure view's row list. So the advanced
 * filter could only ever name a top-level field, while the list view right
 * beside it renders — and types, and edits — every nested one. Filtering by
 * `customData.format` was the one thing you could see but not ask for.
 *
 * The paths come from the page already loaded (`QueryResult.rows` +
 * `row_types`), which is the same material `flattenDocument` renders in the
 * list view: no extra round trip, and a field the user can see is a field they
 * can filter on. The flip side is that this is a *sample* — a field absent from
 * every loaded document is absent from the list too — which is why the picker
 * that renders these also accepts a hand-typed path. The suggestions are a
 * convenience; the dotted path is the real interface, and Mongo resolves it
 * server-side either way.
 *
 * **An array contributes no index.** `items.sku` is offered, `items.0.sku` is
 * not, because BSON query paths traverse arrays implicitly: `{"items.sku": x}`
 * matches a document with *any* element whose `sku` is `x`, which is what
 * someone filtering a document collection means. (The list view's paths do the
 * opposite — they carry the index, because a `$set` needs to name one element.
 * Same trees, different question.)
 *
 * Pure and covered by `fieldPaths.test.ts`.
 */

import { childTypeTree, resolveType } from "./documentTree";
import type { BsonTypeTree, CellValue, ColumnInfo } from "@/types";

/** One selectable field: a column name, or a dotted path below one. */
export interface FilterField {
  /** `stats.count` — what goes into `ColumnFilter.column`. */
  path: string;
  /** Type name for value coercion and for the picker's right gutter. */
  type?: string;
  /** True for a path below the document root (i.e. not a grid column). */
  nested: boolean;
}

/**
 * How deep below a column the walk goes. Deep enough for the nesting people
 * actually query, shallow enough that a pathological document (a linked list
 * modelled as nested objects) can't turn the picker into a wall of text.
 */
export const MAX_FIELD_PATH_DEPTH = 5;

/** Ceiling on how many nested paths one page can contribute. */
export const MAX_NESTED_FIELD_PATHS = 400;

/**
 * Elements inspected per array. An array of 10,000 subdocuments describes its
 * own shape in the first few; scanning all of them, for every array, in every
 * row of the page, would cost far more than the answer is worth.
 */
const MAX_ARRAY_ELEMENTS = 25;

/** Stored type meaning "every value seen here was null" — the same answer
 *  `infer_column_type` gives on the Rust side for an all-null field. */
const NULL_ONLY = "null";

/**
 * Collect the nested field paths present in a page of documents.
 *
 * Types are merged across rows the way the backend merges a column's:
 * the first non-null type wins, a later disagreement makes it `"mixed"` (BSON
 * is schemaless, so that is the honest answer rather than picking one), and a
 * path that was only ever null stays `"null"`.
 */
export function collectNestedFieldPaths(
  columns: { name: string }[],
  rows: CellValue[][],
  rowTypes?: BsonTypeTree[][] | null,
  limit: number = MAX_NESTED_FIELD_PATHS,
): FilterField[] {
  /** Discovery order, so the picker lists a parent before its children. */
  const order: string[] = [];
  const types = new Map<string, string>();

  /** Record one path's type. Returns false once the cap is reached. */
  const record = (path: string, type: string): boolean => {
    const seen = types.get(path);
    if (seen === undefined) {
      if (order.length >= limit) return false;
      order.push(path);
      types.set(path, type);
      return true;
    }
    if (type !== NULL_ONLY && seen !== type) {
      types.set(path, seen === NULL_ONLY ? type : "mixed");
    }
    return true;
  };

  const walk = (
    prefix: string,
    value: CellValue,
    tree: BsonTypeTree | undefined,
    depth: number,
  ) => {
    if (depth > MAX_FIELD_PATH_DEPTH) return;
    if (Array.isArray(value)) {
      // Same prefix, not `prefix.i` — see the header on implicit traversal.
      // The depth is not spent either: `items.sku` is one level below `items`
      // however many arrays sit between them.
      const n = Math.min(value.length, MAX_ARRAY_ELEMENTS);
      for (let i = 0; i < n; i++) {
        walk(prefix, value[i] as CellValue, childTypeTree(tree, String(i)), depth);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    const obj = value as Record<string, CellValue>;
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      const childTree = childTypeTree(tree, key);
      const path = `${prefix}.${key}`;
      if (!record(path, resolveType(child, childTree))) return;
      walk(path, child, childTree, depth + 1);
    }
  };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < columns.length; c++) {
      walk(columns[c].name, row?.[c] ?? null, rowTypes?.[r]?.[c], 1);
    }
  }

  return order.map((path) => ({ path, type: types.get(path), nested: true }));
}

/**
 * Merge the catalog columns with the nested paths found on the page, each
 * nested path sitting directly under the column it belongs to.
 *
 * Grouped rather than appended so the picker reads like the document does —
 * `stats`, then `stats.count`, then `stats.avg` — instead of listing every
 * column and then every path again from the top. A path whose root is not a
 * column (possible only if the page and the catalog disagree) is kept at the
 * end rather than dropped: it is still a filterable field.
 */
export function filterFieldsFor(
  columns: ColumnInfo[],
  nested: FilterField[],
): FilterField[] {
  const byRoot = new Map<string, FilterField[]>();
  for (const f of nested) {
    const cut = f.path.indexOf(".");
    const root = cut === -1 ? f.path : f.path.slice(0, cut);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(f);
    else byRoot.set(root, [f]);
  }

  const out: FilterField[] = [];
  for (const c of columns) {
    out.push({ path: c.name, type: c.data_type, nested: false });
    for (const f of byRoot.get(c.name) ?? []) {
      if (f.path !== c.name) out.push(f);
    }
    byRoot.delete(c.name);
  }
  for (const rest of byRoot.values()) out.push(...rest);
  return out;
}

/**
 * The fields matching a picker query, prefix matches first.
 *
 * Plain case-insensitive substring on the whole dotted path, so typing
 * `format` finds `customData.format` and typing `customData.` lists that
 * subtree. No fuzzy matching: a field path is short and the user is usually
 * completing one they have already seen in the grid.
 */
export function matchFieldPaths(
  fields: FilterField[],
  query: string,
): FilterField[] {
  const q = query.trim().toLowerCase();
  if (q === "") return fields;
  const prefix: FilterField[] = [];
  const rest: FilterField[] = [];
  for (const f of fields) {
    const path = f.path.toLowerCase();
    if (path.startsWith(q)) prefix.push(f);
    else if (path.includes(q)) rest.push(f);
  }
  return prefix.concat(rest);
}
