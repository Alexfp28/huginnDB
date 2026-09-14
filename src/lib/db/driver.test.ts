/**
 * The database-level capability predicates.
 *
 * Written for one bug and kept for the rule it encodes: `supportsDropDatabase`
 * used to *be* `supportsCreateDatabase`, so MongoDB — which cannot create an
 * empty database, because the server has no such thing — was also refused the
 * ability to drop a full one. The two answers only coincide by accident, and
 * these tests are what makes the next person merging them notice.
 */

import { describe, expect, it } from "vitest";

import {
  requiresInitialCollection,
  supportsCreateDatabase,
  supportsDropDatabase,
} from "@/lib/db/driver";
import type { Driver } from "@/types";

const DRIVERS: Driver[] = [
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "sqlserver",
];

describe("database-level capabilities", () => {
  it("offers create on every driver but SQLite", () => {
    for (const driver of DRIVERS) {
      expect(supportsCreateDatabase(driver)).toBe(driver !== "sqlite");
    }
  });

  it("offers drop on every driver but SQLite", () => {
    for (const driver of DRIVERS) {
      expect(supportsDropDatabase(driver)).toBe(driver !== "sqlite");
    }
  });

  it("asks for a first collection on MongoDB and nowhere else", () => {
    for (const driver of DRIVERS) {
      expect(requiresInitialCollection(driver)).toBe(driver === "mongodb");
    }
  });

  it("treats an unknown connection as incapable rather than capable", () => {
    // The profile is looked up by id and can legitimately be missing for a
    // frame; defaulting to "yes, offer DROP DATABASE" would be the wrong way
    // round to be wrong.
    expect(supportsCreateDatabase(undefined)).toBe(false);
    expect(supportsDropDatabase(undefined)).toBe(false);
    expect(requiresInitialCollection(undefined)).toBe(false);
  });
});
