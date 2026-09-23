import { describe, expect, it } from "vitest";
import {
  isLockedField,
  isNarrowing,
  wireProjection,
} from "@/lib/grid/projection";

const sql = { document: false, keyColumns: ["id"] };
const mongo = { document: true, keyColumns: [] };

describe("wireProjection", () => {
  it("sends nothing when nothing is narrowed", () => {
    expect(wireProjection(undefined, sql)).toBeUndefined();
    expect(wireProjection({ fields: [] }, sql)).toBeUndefined();
    expect(isNarrowing({ fields: [] })).toBe(false);
  });

  it("puts the primary key first on SQL, so every row stays editable", () => {
    expect(wireProjection({ fields: ["code", "ts"] }, sql)).toEqual({
      fields: ["id", "code", "ts"],
      exclude: false,
    });
  });

  it("does not repeat a key the user already picked", () => {
    expect(wireProjection({ fields: ["code", "id"] }, sql)).toEqual({
      fields: ["code", "id"],
      exclude: false,
    });
  });

  it("carries every column of a composite key", () => {
    expect(
      wireProjection(
        { fields: ["qty"] },
        { document: false, keyColumns: ["order_id", "line"] },
      ),
    ).toEqual({ fields: ["order_id", "line", "qty"], exclude: false });
  });

  it("drops an exclusion on SQL rather than sending what the backend rejects", () => {
    expect(
      wireProjection({ fields: ["code"], exclude: true }, sql),
    ).toBeUndefined();
  });

  it("sends a MongoDB inclusion as chosen — `_id` comes back by default", () => {
    expect(wireProjection({ fields: ["code"] }, mongo)).toEqual({
      fields: ["code"],
      exclude: false,
    });
  });

  it("never excludes `_id` on MongoDB", () => {
    expect(
      wireProjection({ fields: ["_id", "configuration"], exclude: true }, mongo),
    ).toEqual({ fields: ["configuration"], exclude: true });
    expect(
      wireProjection({ fields: ["_id"], exclude: true }, mongo),
    ).toBeUndefined();
  });

  it("deduplicates", () => {
    expect(wireProjection({ fields: ["a", "a"] }, mongo)).toEqual({
      fields: ["a"],
      exclude: false,
    });
  });
});

describe("isLockedField", () => {
  it("locks the primary key on SQL and `_id` on MongoDB", () => {
    expect(isLockedField("id", { ...sql, exclude: false })).toBe(true);
    expect(isLockedField("code", { ...sql, exclude: false })).toBe(false);
    expect(isLockedField("_id", { ...mongo, exclude: false })).toBe(true);
    expect(isLockedField("_id", { ...mongo, exclude: true })).toBe(true);
  });
});
