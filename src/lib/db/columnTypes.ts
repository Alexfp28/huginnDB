/**
 * Curated, per-driver, *categorised* column type catalogs for the structure
 * editor's type picker (HeidiSQL-style: a grouped dropdown for the base type
 * plus a separate length/precision field, rather than one flat freeform
 * string). These are suggestions, not a closed set — `ColumnsEditor` falls
 * back to a raw text field ("custom type") the moment a loaded column's
 * `dataType` doesn't match anything here, so an exotic/parameterised type
 * (a Postgres domain, an array type, …) never becomes unrepresentable. The
 * backend validates the final string before it reaches DDL (`validate_type`
 * in db/ddl.rs), so this list only needs to cover the common cases to save
 * typing and prevent typos.
 */

import type { Driver } from "@/types";

export interface ColumnTypeOption {
  /** Canonical type keyword sent to the backend as (part of) `dataType`. */
  name: string;
  /** Whether this type takes a parenthesised length/precision/set spec. */
  hasLength?: boolean;
  /** Prefilled into the length field when the user picks this type fresh. */
  defaultLength?: string;
  /** MySQL only: whether UNSIGNED/ZEROFILL apply to this type. */
  unsignedCapable?: boolean;
}

export interface ColumnTypeCategory {
  /** i18n key suffix — see `structure.typeCategory.*`. */
  key: string;
  types: ColumnTypeOption[];
}

const MYSQL: ColumnTypeCategory[] = [
  {
    key: "integer",
    types: [
      { name: "tinyint", hasLength: true, defaultLength: "4", unsignedCapable: true },
      { name: "boolean" },
      { name: "smallint", hasLength: true, defaultLength: "6", unsignedCapable: true },
      { name: "mediumint", hasLength: true, defaultLength: "9", unsignedCapable: true },
      { name: "int", hasLength: true, defaultLength: "11", unsignedCapable: true },
      { name: "bigint", hasLength: true, defaultLength: "20", unsignedCapable: true },
    ],
  },
  {
    key: "real",
    types: [
      { name: "float", hasLength: true, defaultLength: "10,2", unsignedCapable: true },
      { name: "double", hasLength: true, defaultLength: "16,4", unsignedCapable: true },
      { name: "decimal", hasLength: true, defaultLength: "10,2", unsignedCapable: true },
    ],
  },
  {
    key: "text",
    types: [
      { name: "char", hasLength: true, defaultLength: "1" },
      { name: "varchar", hasLength: true, defaultLength: "255" },
      { name: "tinytext" },
      { name: "text" },
      { name: "mediumtext" },
      { name: "longtext" },
      { name: "enum", hasLength: true, defaultLength: "'a','b'" },
      { name: "set", hasLength: true, defaultLength: "'a','b'" },
    ],
  },
  {
    key: "datetime",
    types: [
      { name: "date" },
      { name: "datetime" },
      { name: "timestamp" },
      { name: "time" },
      { name: "year" },
    ],
  },
  {
    key: "binary",
    types: [
      { name: "binary", hasLength: true, defaultLength: "16" },
      { name: "varbinary", hasLength: true, defaultLength: "255" },
      { name: "tinyblob" },
      { name: "blob" },
      { name: "mediumblob" },
      { name: "longblob" },
      { name: "bit", hasLength: true, defaultLength: "1" },
    ],
  },
  {
    key: "other",
    types: [{ name: "json" }],
  },
];

const POSTGRES: ColumnTypeCategory[] = [
  {
    key: "integer",
    types: [
      { name: "smallint" },
      { name: "integer" },
      { name: "bigint" },
      { name: "smallserial" },
      { name: "serial" },
      { name: "bigserial" },
    ],
  },
  {
    key: "real",
    types: [
      { name: "real" },
      { name: "double precision" },
      { name: "numeric", hasLength: true, defaultLength: "10,2" },
      { name: "money" },
    ],
  },
  {
    key: "text",
    types: [
      { name: "char", hasLength: true, defaultLength: "1" },
      { name: "varchar", hasLength: true, defaultLength: "255" },
      { name: "text" },
      { name: "uuid" },
    ],
  },
  {
    key: "datetime",
    types: [
      { name: "date" },
      { name: "time" },
      { name: "timestamp" },
      { name: "timestamptz" },
      { name: "interval" },
    ],
  },
  {
    key: "binary",
    types: [{ name: "bytea" }],
  },
  {
    key: "other",
    types: [
      { name: "boolean" },
      { name: "json" },
      { name: "jsonb" },
      { name: "xml" },
      { name: "inet" },
      { name: "cidr" },
      { name: "macaddr" },
    ],
  },
];

const SQLITE: ColumnTypeCategory[] = [
  { key: "integer", types: [{ name: "INTEGER" }] },
  { key: "real", types: [{ name: "REAL" }, { name: "NUMERIC" }] },
  { key: "text", types: [{ name: "TEXT" }] },
  { key: "datetime", types: [{ name: "DATETIME" }] },
  { key: "binary", types: [{ name: "BLOB" }] },
  { key: "other", types: [{ name: "BOOLEAN" }] },
];

/** BSON types for MongoDB (used as field-type labels; structure editing is
 *  read-only for Mongo in this version). */
const MONGODB: ColumnTypeCategory[] = [
  {
    key: "other",
    types: [
      "objectId",
      "string",
      "int",
      "long",
      "double",
      "decimal128",
      "bool",
      "date",
      "document",
      "array",
      "binary",
      "null",
    ].map((name) => ({ name })),
  },
];

/** Categorised type catalog for a driver. Falls back to Postgres's when
 *  the driver is unknown. */
export function columnCategoriesFor(driver: Driver | undefined): ColumnTypeCategory[] {
  switch (driver) {
    case "postgres":
      return POSTGRES;
    case "mysql":
      return MYSQL;
    case "sqlite":
      return SQLITE;
    case "mongodb":
      return MONGODB;
    default:
      return POSTGRES;
  }
}

export interface ParsedColumnType {
  /** Matched catalog type name, or "" when the raw string didn't match
   *  anything (custom/exotic type — shown verbatim in a text field). */
  baseType: string;
  /** Parenthesised length/precision/set content, without the parens. */
  length: string;
  unsigned: boolean;
  zerofill: boolean;
  /** The raw string, used verbatim when `baseType` is "". */
  custom: string;
}

/**
 * Best-effort decomposition of a raw `dataType` string (e.g. "int(11)
 * unsigned zerofill", "varchar(255)") into the structured pieces the editor
 * shows separately. Matches catalog names longest-first so a multi-word type
 * ("double precision") isn't shadowed by a shorter prefix ("double"), and
 * only recognises a match when it's followed by "(", whitespace, or the
 * string end — a plain prefix like "int" must never match "integer".
 */
export function parseColumnType(
  raw: string,
  categories: ColumnTypeCategory[],
): ParsedColumnType {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const allTypes = [...categories.flatMap((c) => c.types)].sort(
    (a, b) => b.name.length - a.name.length,
  );
  for (const t of allTypes) {
    const tn = t.name.toLowerCase();
    if (
      lower === tn ||
      lower.startsWith(`${tn}(`) ||
      lower.startsWith(`${tn} `)
    ) {
      let rest = trimmed.slice(t.name.length).trim();
      let length = "";
      const parenMatch = rest.match(/^\(([^)]*)\)/);
      if (parenMatch) {
        length = parenMatch[1].trim();
        rest = rest.slice(parenMatch[0].length).trim();
      }
      const restLower = rest.toLowerCase();
      return {
        baseType: t.name,
        length,
        unsigned: /\bunsigned\b/.test(restLower),
        zerofill: /\bzerofill\b/.test(restLower),
        custom: "",
      };
    }
  }
  return { baseType: "", length: "", unsigned: false, zerofill: false, custom: trimmed };
}

/** Recompose the structured pieces back into the raw `dataType` string sent
 *  to the backend. Mirrors MySQL's clause order: type(length) [UNSIGNED]
 *  [ZEROFILL]. ZEROFILL implies UNSIGNED (MySQL auto-applies it), so the
 *  composed string always carries both when zerofill is set. */
export function composeColumnType(parsed: ParsedColumnType): string {
  if (!parsed.baseType) return parsed.custom;
  let s = parsed.baseType;
  if (parsed.length.trim()) s += `(${parsed.length.trim()})`;
  if (parsed.unsigned || parsed.zerofill) s += " unsigned";
  if (parsed.zerofill) s += " zerofill";
  return s;
}
