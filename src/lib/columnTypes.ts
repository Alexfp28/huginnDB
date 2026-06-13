/**
 * Curated, per-driver lists of common column types for the structure editor's
 * type combobox. These are suggestions, not a closed set — the field stays
 * editable so a user can type a parameterised or exotic type (e.g.
 * `varchar(40)`, `numeric(10,2)`, a custom domain). The backend validates the
 * final string before it reaches DDL (`validate_type` in db/ddl.rs), so the
 * list only needs to cover the common cases to save typing and prevent typos.
 */

import type { Driver } from "@/types";

const POSTGRES: string[] = [
  "integer",
  "bigint",
  "smallint",
  "serial",
  "bigserial",
  "boolean",
  "text",
  "varchar(255)",
  "char(1)",
  "numeric(10,2)",
  "real",
  "double precision",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
  "json",
  "jsonb",
  "bytea",
];

const MYSQL: string[] = [
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "tinyint(1)",
  "bit(1)",
  "boolean",
  "varchar(255)",
  "char(1)",
  "text",
  "longtext",
  "mediumtext",
  "decimal(10,2)",
  "float",
  "double",
  "date",
  "datetime",
  "timestamp",
  "time",
  "year",
  "json",
  "blob",
  "longblob",
];

const SQLITE: string[] = [
  "INTEGER",
  "TEXT",
  "REAL",
  "BLOB",
  "NUMERIC",
  "BOOLEAN",
  "DATETIME",
];

/** BSON types for MongoDB (used as field-type labels; structure editing is
 *  read-only for Mongo in this version). */
const MONGODB: string[] = [
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
];

/** Suggested types for a driver. Falls back to a generic set when unknown. */
export function columnTypesFor(driver: Driver | undefined): string[] {
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
      return [...POSTGRES];
  }
}
