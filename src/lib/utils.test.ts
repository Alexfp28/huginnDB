/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from "vitest";

import { usePreferences } from "@/stores/preferences/preferences";
import {
  bucketByGroup,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatNumber,
} from "./utils";

function setLanguage(language: "en" | "es") {
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ui: { ...s.prefs.ui, language } },
  }));
}

describe("formatNumber", () => {
  beforeEach(() => setLanguage("en"));

  // The bug these exist for: a bare `toLocaleString()` follows the OS locale,
  // not `ui.language`, so a Spanish UI on an English machine showed `1,234`.
  it("uses the separators of the selected language, not the platform's", () => {
    setLanguage("en");
    expect(formatNumber(1234567)).toBe("1,234,567");
    setLanguage("es");
    expect(formatNumber(1234567)).toBe("1.234.567");
  });

  it("returns an empty string for a non-finite input", () => {
    expect(formatNumber(Number.NaN)).toBe("");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formatDateTime", () => {
  it("follows the selected language", () => {
    const iso = "2026-08-21T15:04:05.000Z";
    setLanguage("en");
    const en = formatDateTime(iso);
    setLanguage("es");
    const es = formatDateTime(iso);
    // Not asserting exact output — that depends on the host time zone — only
    // that the language is honoured, which is the whole point of the helper.
    expect(en).not.toBe(es);
    expect(en).toMatch(/\d/);
    expect(es).toMatch(/\d/);
  });
});

describe("the compact formatters are locale-independent by design", () => {
  it("formatBytes / formatCount / formatDuration", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatCount(1500)).toBe("1.5k");
    expect(formatCount(2_500_000)).toBe("2.5M");
    expect(formatCount(999)).toBe("999");
    expect(formatDuration(842)).toBe("842 ms");
    expect(formatDuration(1240)).toBe("1.24 s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(-1)).toBe("0 ms");
  });
});

// The connection rail now calls this once per provenance section, so its two
// quiet contracts — what counts as ungrouped, and what order things come out in
// — are worth pinning down.
describe("bucketByGroup", () => {
  it("treats null, undefined and empty-string groups as ungrouped", () => {
    const { ungrouped, groups } = bucketByGroup([
      { id: "a", group: null },
      { id: "b" },
      { id: "c", group: "" },
      { id: "d", group: "Prod" },
    ]);
    expect(ungrouped.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(groups).toEqual([{ name: "Prod", items: [{ id: "d", group: "Prod" }] }]);
  });

  it("sorts group names locale-aware, not by code point", () => {
    setLanguage("es");
    const { groups } = bucketByGroup([
      { group: "Zulu" },
      { group: "Ávila" },
      { group: "Alfa" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Alfa", "Ávila", "Zulu"]);
  });

  it("preserves the input order inside a group", () => {
    const { groups } = bucketByGroup([
      { id: "z", group: "Prod" },
      { id: "a", group: "Prod" },
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["z", "a"]);
  });

  it("returns two empty buckets for an empty list", () => {
    expect(bucketByGroup([])).toEqual({ ungrouped: [], groups: [] });
  });
});
