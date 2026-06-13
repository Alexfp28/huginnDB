/**
 * SQL keyword catalogue for editor autocomplete.
 *
 * Two tiers: a `COMMON` set that every supported driver understands,
 * and a small driver-specific overlay for the obvious wins (`RETURNING`
 * on Postgres, `ON DUPLICATE KEY` on MySQL, …). The catalogue is
 * deliberately compact — the goal is to surface the half-dozen tokens
 * users actually start typing, not to reproduce every reserved word
 * from the SQL standard.
 *
 * Entries are uppercased here; the editor does case-insensitive
 * matching so users typing in lowercase still see them.
 */

import type { Driver } from "@/types";

/** Keywords every driver groks. Ordered roughly by typing frequency. */
export const COMMON_KEYWORDS: ReadonlyArray<string> = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "LIKE",
  "BETWEEN",
  "AS",
  "ON",
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "OUTER JOIN",
  "FULL JOIN",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "UNION",
  "UNION ALL",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "TRUE",
  "FALSE",
  "ASC",
  "DESC",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
];

/** Postgres-specific additions. */
const POSTGRES_EXTRA: ReadonlyArray<string> = [
  "RETURNING",
  "ILIKE",
  "USING",
  "EXTRACT",
  "::",
];

/** MySQL-specific additions. */
const MYSQL_EXTRA: ReadonlyArray<string> = [
  "ON DUPLICATE KEY UPDATE",
  "IGNORE",
  "STRAIGHT_JOIN",
  "REGEXP",
];

/** SQLite-specific additions. */
const SQLITE_EXTRA: ReadonlyArray<string> = [
  "PRAGMA",
  "AUTOINCREMENT",
  "GLOB",
];

/**
 * MongoDB is not SQL: its editor completions are the shell methods and the
 * common MQL/aggregation operators, not the SQL keyword set. Collection and
 * field names are layered on top from the live schema by the completion
 * builder, same as the SQL drivers.
 */
const MONGODB_KEYWORDS: ReadonlyArray<string> = [
  // Collection methods
  "find",
  "findOne",
  "aggregate",
  "countDocuments",
  "distinct",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "sort",
  "limit",
  "skip",
  "projection",
  // Query operators
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$and",
  "$or",
  "$not",
  "$exists",
  "$regex",
  "$type",
  // Update operators
  "$set",
  "$unset",
  "$inc",
  "$push",
  "$pull",
  "$addToSet",
  // Aggregation stages
  "$match",
  "$group",
  "$project",
  "$sort",
  "$limit",
  "$skip",
  "$lookup",
  "$unwind",
  "$count",
  "$sum",
  "$avg",
  // Constructors
  "ObjectId",
  "ISODate",
  "NumberLong",
  "NumberDecimal",
];

/**
 * Compose the full keyword list for a driver, falling back to the
 * shared set when the driver is unknown (e.g. when the editor is open
 * but the connection is gone). Returns a fresh array so callers can
 * mutate it without affecting the source-of-truth constants.
 */
export function keywordsFor(driver: Driver | undefined): string[] {
  switch (driver) {
    case "postgres":
      return [...COMMON_KEYWORDS, ...POSTGRES_EXTRA];
    case "mysql":
      return [...COMMON_KEYWORDS, ...MYSQL_EXTRA];
    case "sqlite":
      return [...COMMON_KEYWORDS, ...SQLITE_EXTRA];
    case "mongodb":
      // Mongo is not SQL — return only the shell/MQL vocabulary.
      return [...MONGODB_KEYWORDS];
    default:
      return [...COMMON_KEYWORDS];
  }
}
