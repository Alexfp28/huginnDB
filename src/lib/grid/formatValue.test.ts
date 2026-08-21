import { describe, expect, it } from "vitest";

import { formatValue } from "./formatValue";

describe("formatValue", () => {
  it("renders NULL as the empty string, not the word", () => {
    // The grid draws its own NULL affordance, and a client-side search for
    // "null" must not match every empty cell.
    expect(formatValue(null)).toBe("");
    expect(formatValue(undefined)).toBe("");
  });

  it("passes primitives through as text", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(false)).toBe("false");
    expect(formatValue("already text")).toBe("already text");
  });

  it("serialises objects and arrays as JSON", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, "two"])).toBe('[1,"two"]');
  });
});
