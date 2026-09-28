import { describe, expect, it } from "vitest";
import { foldForSearch, matchSettings } from "./searchSettings";

const items = [
  { label: "Keepalive interval", rest: "Ping idle connections Connections" },
  { label: "Close idle database views after", rest: "Connections" },
  { label: "Soft-wrap long lines", rest: "wrap ajuste de línea Editor" },
  { label: "Idle timeout", rest: "AI assistant" },
];
const run = (q: string) =>
  matchSettings(q, items, (i) => i).map((i) => i.label);

describe("foldForSearch", () => {
  it("drops case and accents", () => {
    expect(foldForSearch("Línea ÁRBOL")).toBe("linea arbol");
  });
});

describe("matchSettings", () => {
  it("returns nothing for a blank query rather than everything", () => {
    expect(run("")).toEqual([]);
    expect(run("   ")).toEqual([]);
  });

  it("needs every word, in any order", () => {
    expect(run("views idle")).toEqual(["Close idle database views after"]);
    expect(run("idle nonsense")).toEqual([]);
  });

  it("ranks label hits above description hits, stable otherwise", () => {
    expect(run("idle")).toEqual([
      "Close idle database views after",
      "Idle timeout",
      "Keepalive interval",
    ]);
  });

  it("finds a keyword typed without its accent", () => {
    expect(run("linea")).toEqual(["Soft-wrap long lines"]);
  });

  it("does not match scattered letters the way the palette's fuzzy matcher does", () => {
    // "kpl" is a subsequence of "Keepalive" (K-e-e-P-a-L), so the palette would
    // offer it; in a list scanned by eye that is noise, not forgiveness.
    expect(run("kpl")).toEqual([]);
  });
});
