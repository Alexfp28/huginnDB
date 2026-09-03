import { describe, expect, it } from "vitest";
import { STAGE_CATALOG, snippetFor } from "./stages";
import { ACCUMULATOR_CATALOG } from "./accumulators";

/**
 * `insertSnippet` is hand-escaped Monaco snippet syntax next to `snippet`,
 * plain text describing the exact same structure — the two are meant to
 * stay in lockstep, and drifting apart is invisible until a user actually
 * accepts the completion and watches a `"$field"` reference silently vanish
 * (an unescaped `$name` reads as an unresolved TextMate variable, not a
 * literal dollar sign).
 *
 * `stripSnippetSyntax` reverses the snippet markup — unescape `\$` back to
 * `$`, collapse `${n:default}`/`${n}`/`$n` down to their default text (or
 * nothing) — which should reproduce `snippet`'s own "operator: value"
 * fragment exactly. That equality is the whole test: it catches a missed
 * escape, a wrong default, or a stray indentation slip in one assertion per
 * stage, without hand-transcribing the expected text twice.
 */
function stripSnippetSyntax(s: string): string {
  return s
    .replace(/\\\$/g, "$")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$\d+/g, "");
}

/** An unescaped `$name` (letters, not digits) left in a snippet is a bug:
 *  Monaco's snippet parser reads it as a variable reference, and an unknown
 *  one silently resolves to empty text rather than erroring. */
function unescapedVariableRefs(s: string): string[] {
  const withoutEscapes = s.replace(/\\\$/g, "");
  const withoutTabstops = stripSnippetSyntax(withoutEscapes);
  return withoutTabstops.match(/\$[A-Za-z_]\w*/g) ?? [];
}

describe("stage insertSnippet stays in lockstep with snippet", () => {
  it.each(STAGE_CATALOG.map((s) => [s.operator, s] as const))(
    "%s strips down to its own plain snippet",
    (operator, stage) => {
      const reconstructed = `{\n  ${stripSnippetSyntax(stage.insertSnippet)}\n}`;
      expect(reconstructed).toBe(snippetFor(operator));
    },
  );

  it.each(STAGE_CATALOG.map((s) => [s.operator, s] as const))(
    "%s escapes every literal $ (no unresolved variable reference)",
    (_operator, stage) => {
      expect(unescapedVariableRefs(stage.insertSnippet)).toEqual([]);
    },
  );
});

describe("accumulator insertSnippet", () => {
  it.each(ACCUMULATOR_CATALOG.map((a) => [a.operator, a] as const))(
    "%s escapes every literal $ (no unresolved variable reference)",
    (_operator, acc) => {
      expect(unescapedVariableRefs(acc.insertSnippet)).toEqual([]);
    },
  );

  it.each(ACCUMULATOR_CATALOG.map((a) => [a.operator, a] as const))(
    "%s wraps the operator in its own object — never valid bare",
    (operator, acc) => {
      const plain = stripSnippetSyntax(acc.insertSnippet);
      expect(plain.trim().startsWith("{")).toBe(true);
      expect(plain).toContain(operator);
    },
  );
});
