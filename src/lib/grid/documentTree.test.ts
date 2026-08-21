import { describe, expect, it } from "vitest";

import {
  BSON_TYPES,
  defaultText,
  draftTypeFor,
  isOpaqueType,
  isValidForType,
  nextArrayIndex,
  pathKey,
  typeValue,
  type DocField,
} from "./documentTree";

describe("draftTypeFor", () => {
  it("renames BSON's `document` to the picker's `object`", () => {
    expect(draftTypeFor("document")).toBe("object");
  });

  it("passes other types through and defaults an untyped field to string", () => {
    expect(draftTypeFor("long")).toBe("long");
    expect(draftTypeFor(undefined)).toBe("string");
    expect(draftTypeFor("")).toBe("string");
  });
});

describe("typeValue", () => {
  it("keeps a type the picker can write", () => {
    for (const t of BSON_TYPES) expect(typeValue(t)).toBe(t);
  });

  // A type the picker cannot write still needs a valid trigger value; its own
  // label is shown separately. These are the same types that refuse inline
  // editing, because committing their display text would store that text.
  it("maps an unwritable type onto string", () => {
    expect(typeValue("dbPointer")).toBe("string");
    expect(typeValue("mixed")).toBe("string");
    expect(isOpaqueType("dbPointer")).toBe(true);
  });
});

describe("defaultText", () => {
  // Retyping to something incompatible must leave a value that parses, or the
  // next commit fails on an empty numeric field.
  it("gives every scalar type a parseable neutral value", () => {
    for (const t of ["int", "long", "double", "decimal128"] as const) {
      expect(defaultText(t)).toBe("0");
      expect(isValidForType(t, defaultText(t))).toBe(true);
    }
    expect(defaultText("bool")).toBe("false");
    expect(defaultText("object")).toBe("{}");
    expect(defaultText("array")).toBe("[]");
    expect(defaultText("string")).toBe("");
  });

  it("gives a date a parseable instant", () => {
    expect(Number.isNaN(Date.parse(defaultText("date")))).toBe(false);
  });
});

describe("nextArrayIndex", () => {
  const field = (path: string[], childCount?: number): DocField =>
    ({ path, childCount }) as DocField;

  // Read from the container's own childCount, not by counting rendered rows: a
  // collapsed array contributes none, and appending must not land on 0 and
  // overwrite the first element.
  it("appends after the container's existing children", () => {
    const fields = [field(["tags"], 3), field(["tags", "0"])];
    expect(nextArrayIndex(fields, ["tags"])).toBe(3);
  });

  it("is 0 for an unknown or empty container", () => {
    expect(nextArrayIndex([], ["tags"])).toBe(0);
    expect(nextArrayIndex([field(["tags"], 0)], ["tags"])).toBe(0);
  });

  it("matches on the whole path, not the leaf name", () => {
    const fields = [field(["a", "tags"], 2), field(["b", "tags"], 5)];
    expect(nextArrayIndex(fields, ["b", "tags"])).toBe(5);
  });
});

describe("pathKey", () => {
  // A field is addressed by its dotted path so `$set`/`$unset` take it as-is.
  it("joins with dots", () => {
    expect(pathKey(["customData", "format"])).toBe("customData.format");
    expect(pathKey(["tags", "2"])).toBe("tags.2");
  });
});
