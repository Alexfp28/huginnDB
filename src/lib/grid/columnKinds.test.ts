import { describe, expect, it } from "vitest";

import { normalizeBitValue } from "./columnKinds";

describe("normalizeBitValue", () => {
  it("maps null/undefined/empty string to empty (null)", () => {
    expect(normalizeBitValue(null)).toBe("");
    expect(normalizeBitValue(undefined)).toBe("");
    expect(normalizeBitValue("")).toBe("");
  });

  it("recognises the canonical numeric and boolean-word forms", () => {
    expect(normalizeBitValue("1")).toBe("1");
    expect(normalizeBitValue("0")).toBe("0");
    expect(normalizeBitValue("true")).toBe("1");
    expect(normalizeBitValue("false")).toBe("0");
    expect(normalizeBitValue("TRUE")).toBe("1");
    expect(normalizeBitValue("False")).toBe("0");
  });

  it("trims surrounding whitespace — pasted clipboard text often carries it", () => {
    expect(normalizeBitValue(" 1\n")).toBe("1");
    expect(normalizeBitValue("\ttrue ")).toBe("1");
  });

  it("falls back to \"1\" for anything else non-empty", () => {
    expect(normalizeBitValue("49")).toBe("1");
    expect(normalizeBitValue("yes")).toBe("1");
  });

  it("treats whitespace-only text as empty (null), not as a fallback value", () => {
    expect(normalizeBitValue("   ")).toBe("");
  });
});
