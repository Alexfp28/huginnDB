import { describe, expect, it } from "vitest";
import {
  fuzzyMatch,
  fuzzyMatchFields,
  highlightChunks,
  type MatchRange,
} from "./fuzzy";

/**
 * The scores here are not a contract — only their *ordering* is, which is the
 * whole reason this module exists (a bare `includes()` ranked every hit
 * identically). So these tests assert relative order and the match ranges, and
 * never a literal score.
 *
 * `ranges` matters as much as `score`: they drive the bolding in the palette
 * row, and a range that runs past the end of the label renders as a highlight
 * over nothing.
 */

const score = (needle: string, hay: string) => fuzzyMatch(needle, hay)?.score;

/** Assert `winner` outranks `loser` for `needle`. */
function beats(needle: string, winner: string, loser: string) {
  const w = score(needle, winner);
  const l = score(needle, loser);
  expect(w, `no match for ${winner}`).toBeDefined();
  expect(l, `no match for ${loser}`).toBeDefined();
  expect(w!).toBeGreaterThan(l!);
}

/** The substrings a result would highlight. */
const matched = (needle: string, hay: string) =>
  (fuzzyMatch(needle, hay)?.ranges ?? []).map(([a, b]) => hay.slice(a, b));

describe("fuzzyMatch", () => {
  it("returns a neutral match for an empty needle", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, ranges: [] });
  });

  it("returns null when a character is missing entirely", () => {
    expect(fuzzyMatch("zzz", "Open preferences")).toBeNull();
  });

  it("returns null when the characters are present but out of order", () => {
    expect(fuzzyMatch("ba", "abc")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("OPEN", "Open preferences")).not.toBeNull();
  });
});

describe("fuzzyMatch ranking tiers", () => {
  it("ranks a prefix above a word-start match", () => {
    beats("pre", "preferences", "Open preferences");
  });

  it("ranks a word-start match above a mid-word substring", () => {
    beats("ref", "Open refresh", "Prefetch");
  });

  it("ranks any substring above a scattered subsequence", () => {
    beats("prefs", "prefs", "Profile refresh");
  });

  it("breaks a tie on the shorter haystack", () => {
    beats("users", "users", "users_audit_log");
  });

  it("prefers an earlier occurrence of the same substring", () => {
    beats("log", "log level", "audit log level");
  });
});

describe("fuzzyMatch subsequence anchoring", () => {
  it("anchors on a later word start rather than the first stray character", () => {
    // The greedy left-to-right pass would take the `p` of "Open" and scatter
    // the rest; the anchored retry finds `pref` as one run.
    expect(matched("prefs", "Open preferences")).toContain("pref");
  });

  it("rewards a dense abbreviation over a scattered one", () => {
    beats("prefs", "Open preferences", "Profile refresh set");
  });

  it("matches a camelCase word boundary", () => {
    expect(fuzzyMatch("ww", "wordWrap")).not.toBeNull();
    expect(matched("ww", "wordWrap")).toEqual(["w", "W"]);
  });
});

describe("fuzzyMatch tokens", () => {
  it("requires every whitespace-separated token to match", () => {
    expect(fuzzyMatch("wrap editor", "Editor: soft-wrap long lines")).not.toBeNull();
    expect(fuzzyMatch("wrap missing", "Editor: soft-wrap long lines")).toBeNull();
  });

  it("does not care about token order", () => {
    const a = fuzzyMatch("wrap editor", "Editor: soft-wrap long lines");
    const b = fuzzyMatch("editor wrap", "Editor: soft-wrap long lines");
    expect(a?.score).toBe(b?.score);
  });

  it("merges the tokens' ranges into an ascending, non-overlapping list", () => {
    const hit = fuzzyMatch("editor soft", "Editor: soft-wrap long lines")!;
    expect(hit.ranges).toEqual([
      [0, 6],
      [8, 12],
    ] satisfies MatchRange[]);
  });

  it("merges overlapping token ranges rather than emitting both", () => {
    const hit = fuzzyMatch("edit dito", "Editor")!;
    for (let i = 1; i < hit.ranges.length; i++) {
      expect(hit.ranges[i]![0]).toBeGreaterThan(hit.ranges[i - 1]![1]);
    }
  });

  it("keeps every range inside the haystack", () => {
    const hay = "Editor: soft-wrap long lines";
    for (const [start, end] of fuzzyMatch("wrap lines", hay)!.ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(hay.length);
      expect(end).toBeGreaterThan(start);
    }
  });
});

describe("fuzzyMatchFields", () => {
  it("reports the primary match and its ranges when the label hits", () => {
    const hit = fuzzyMatchFields("pref", "Open preferences", ["settings"])!;
    expect(hit.ranges.length).toBeGreaterThan(0);
  });

  it("falls back to a secondary field with no ranges to highlight", () => {
    const hit = fuzzyMatchFields("settings", "Open preferences", ["settings"])!;
    expect(hit).not.toBeNull();
    expect(hit.ranges).toEqual([]);
  });

  it("never lets a keyword hit outrank a real label hit", () => {
    const viaLabel = fuzzyMatchFields("settings", "Settings", [])!;
    const viaKeyword = fuzzyMatchFields("settings", "Open preferences", [
      "settings",
    ])!;
    expect(viaLabel.score).toBeGreaterThan(viaKeyword.score);
  });

  it("returns null when neither the label nor any keyword matches", () => {
    expect(fuzzyMatchFields("zzz", "Open preferences", ["settings"])).toBeNull();
  });

  it("ignores empty secondary fields", () => {
    expect(fuzzyMatchFields("zzz", "Open preferences", ["", ""])).toBeNull();
  });
});

describe("highlightChunks", () => {
  it("returns the whole text unmatched when there is nothing to highlight", () => {
    expect(highlightChunks("Editor", [])).toEqual([
      { text: "Editor", match: false },
    ]);
  });

  it("alternates plain and matched chunks", () => {
    expect(highlightChunks("Editor: wrap", [[8, 12]])).toEqual([
      { text: "Editor: ", match: false },
      { text: "wrap", match: true },
    ]);
  });

  it("emits no leading empty chunk when the match starts at 0", () => {
    expect(highlightChunks("Editor", [[0, 4]])).toEqual([
      { text: "Edit", match: true },
      { text: "or", match: false },
    ]);
  });

  it("reassembles into the original text", () => {
    const hay = "Editor: soft-wrap long lines";
    const chunks = highlightChunks(hay, fuzzyMatch("wrap lines", hay)!.ranges);
    expect(chunks.map((c) => c.text).join("")).toBe(hay);
  });
});
