import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  formatForDisplay,
  formatSequence,
  isChordSequence,
  keyTokenFromEvent,
  normalizeChord,
  parseSequence,
  type KeyLike,
} from "./chord";

/** Minimal `KeyLike`; `code` defaults to something that forces the `key`
 *  branches, since most named keys carry no useful `code`. */
function ev(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe("keyTokenFromEvent", () => {
  it("prefers the physical code for letters, so Shift can't change the token", () => {
    expect(keyTokenFromEvent(ev({ key: "k", code: "KeyK" }))).toBe("K");
    // With Shift held the browser reports `key: "K"`, but the code is stable.
    expect(keyTokenFromEvent(ev({ key: "K", code: "KeyK", shiftKey: true }))).toBe("K");
  });

  it("prefers the physical code for digits, so Shift can't turn 1 into !", () => {
    expect(keyTokenFromEvent(ev({ key: "1", code: "Digit1" }))).toBe("1");
    expect(keyTokenFromEvent(ev({ key: "!", code: "Digit1", shiftKey: true }))).toBe("1");
  });

  it("normalizes the space bar's two spellings", () => {
    expect(keyTokenFromEvent(ev({ key: " " }))).toBe("Space");
    expect(keyTokenFromEvent(ev({ key: "Unidentified", code: "Space" }))).toBe("Space");
  });

  it("accepts F1 through F19 and nothing beyond", () => {
    expect(keyTokenFromEvent(ev({ key: "F1" }))).toBe("F1");
    expect(keyTokenFromEvent(ev({ key: "F19" }))).toBe("F19");
    // F20 is not in the range, so it falls through to the raw-key branch —
    // still a token, just not a recognized function key.
    expect(keyTokenFromEvent(ev({ key: "F20" }))).toBe("F20");
  });

  it("keeps named keys as-is", () => {
    for (const key of ["Enter", "Escape", "Tab", "Home", "ArrowUp", "Backspace"]) {
      expect(keyTokenFromEvent(ev({ key }))).toBe(key);
    }
  });

  it("returns null for a bare modifier — that is not a chord yet", () => {
    for (const key of ["Control", "Shift", "Alt", "Meta"]) {
      expect(keyTokenFromEvent(ev({ key }))).toBeNull();
    }
  });

  it("falls back to the raw key for punctuation", () => {
    expect(keyTokenFromEvent(ev({ key: "," }))).toBe(",");
  });
});

describe("chordFromEvent", () => {
  it("collapses ctrl and meta into the platform-neutral Mod", () => {
    expect(chordFromEvent(ev({ key: "k", code: "KeyK", ctrlKey: true }))).toBe("Mod+K");
    expect(chordFromEvent(ev({ key: "k", code: "KeyK", metaKey: true }))).toBe("Mod+K");
  });

  it("emits modifiers in canonical order regardless of how they were held", () => {
    const chord = chordFromEvent(
      ev({ key: "k", code: "KeyK", altKey: true, shiftKey: true, ctrlKey: true }),
    );
    expect(chord).toBe("Mod+Shift+Alt+K");
  });

  it("distinguishes Mod+K from Mod+Shift+K", () => {
    const plain = chordFromEvent(ev({ key: "k", code: "KeyK", ctrlKey: true }));
    const shifted = chordFromEvent(
      ev({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }),
    );
    expect(plain).not.toBe(shifted);
  });

  it("returns null while only a modifier is down", () => {
    expect(chordFromEvent(ev({ key: "Control", ctrlKey: true }))).toBeNull();
  });
});

describe("normalizeChord", () => {
  it("migrates the legacy Ctrl spelling to Mod", () => {
    expect(normalizeChord("Ctrl+K")).toBe("Mod+K");
    expect(normalizeChord("Ctrl+Shift+R")).toBe("Mod+Shift+R");
  });

  it("reorders modifiers into canonical order", () => {
    expect(normalizeChord("Alt+Shift+Ctrl+K")).toBe("Mod+Shift+Alt+K");
  });

  it("deduplicates a modifier written twice", () => {
    expect(normalizeChord("Ctrl+Mod+K")).toBe("Mod+K");
  });

  it("keeps the literal Ctrl-vs-Meta distinction the new tokens allow", () => {
    // `Mod` is the fuzzy one; `Meta` stays exact.
    expect(normalizeChord("Meta+K")).toBe("Meta+K");
  });

  it("returns an empty string when there is no key token, which never matches", () => {
    expect(normalizeChord("Ctrl+")).toBe("");
    expect(normalizeChord("")).toBe("");
  });
});

describe("parseSequence / formatSequence", () => {
  it("splits a chord sequence on spaces and normalizes each chord", () => {
    expect(parseSequence("Ctrl+K Ctrl+S")).toEqual(["Mod+K", "Mod+S"]);
  });

  it("round-trips", () => {
    expect(formatSequence(parseSequence("Mod+K Mod+S"))).toBe("Mod+K Mod+S");
  });

  it("drops unparseable chords rather than producing a binding that half-matches", () => {
    expect(parseSequence("Ctrl+ Mod+S")).toEqual(["Mod+S"]);
    expect(parseSequence("")).toEqual([]);
  });

  it("tells a sequence apart from a single chord", () => {
    expect(isChordSequence("Mod+K")).toBe(false);
    expect(isChordSequence("Mod+K Mod+S")).toBe(true);
  });
});

describe("formatForDisplay", () => {
  it("draws Mod as ⌘ on macOS and Ctrl elsewhere", () => {
    expect(formatForDisplay("Mod+K", true)).toBe("⌘+K");
    expect(formatForDisplay("Mod+K", false)).toBe("Ctrl+K");
  });

  it("still renders a binding stored in the legacy Ctrl spelling", () => {
    expect(formatForDisplay("Ctrl+K", false)).toBe("Ctrl+K");
  });

  it("uses glyphs for keys whose names are longer than their symbols", () => {
    expect(formatForDisplay("Mod+Enter", false)).toBe("Ctrl+↵");
    expect(formatForDisplay("Mod+Backspace", false)).toBe("Ctrl+⌫");
  });

  it("keeps the space between the chords of a sequence", () => {
    expect(formatForDisplay("Mod+K Mod+S", false)).toBe("Ctrl+K Ctrl+S");
  });
});
