import { describe, expect, it } from "vitest";
import { matchesFilter, matchesPatterns, parsePatterns } from "./matchesFilter";

describe("parsePatterns", () => {
  it("splits on ';' and trims each pattern", () => {
    expect(parsePatterns("users; orders")).toEqual(["users", "orders"]);
  });

  it("lowercases, so the needle side is case-insensitive", () => {
    expect(parsePatterns("Users")).toEqual(["users"]);
  });

  it("drops empty segments, so a filter of only separators is no filter", () => {
    expect(parsePatterns(";;;")).toEqual([]);
    expect(parsePatterns("   ")).toEqual([]);
    expect(parsePatterns("")).toEqual([]);
  });
});

describe("matchesPatterns", () => {
  it("matches everything with no patterns", () => {
    expect(matchesPatterns("anything", [])).toBe(true);
  });

  it("ORs the patterns", () => {
    const p = parsePatterns("users; orders");
    expect(matchesPatterns("users", p)).toBe(true);
    expect(matchesPatterns("orders_2024", p)).toBe(true);
    expect(matchesPatterns("invoices", p)).toBe(false);
  });

  it("is case-insensitive on the name side too", () => {
    expect(matchesPatterns("USERS", parsePatterns("users"))).toBe(true);
  });

  it("matches a substring, not only a prefix", () => {
    // The single most-used property of this filter: `ser` finds `users`.
    expect(matchesPatterns("users", parsePatterns("ser"))).toBe(true);
  });
});

describe("matchesFilter — the semantics we are deliberately NOT growing", () => {
  it("does no globbing: '*' is a literal character", () => {
    // If a future version teaches this filter wildcards, that has to be a
    // decision with a migration story, not something a regex refactor
    // introduces by accident.
    expect(matchesFilter("users", "user*")).toBe(false);
    expect(matchesFilter("a*b", "a*b")).toBe(true);
  });

  it("does no accent folding", () => {
    expect(matchesFilter("artículos", "articulos")).toBe(false);
    expect(matchesFilter("artículos", "artíc")).toBe(true);
  });

  it("matches everything when the filter is blank", () => {
    for (const blank of ["", "   ", ";;;"]) {
      expect(matchesFilter("users", blank), blank).toBe(true);
    }
  });
});
