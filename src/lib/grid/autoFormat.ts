/**
 * The *automatic* formatting path: what a cell looks like the moment it opens.
 *
 * Kept apart from `detectContentType.ts`'s `tryFormat` on purpose, because the
 * two answer different questions. `tryFormat` is "make this pretty, I asked for
 * it" — the Format button, one click, the user accepting whatever rewrite comes
 * out. This module is "make this pretty *without being asked*", which has to
 * clear a much higher bar: the formatted text becomes the editor's baseline, so
 * a user who opens a cell and presses Ctrl+S saves whatever came out of here.
 *
 * That is why the whole module exists rather than being a boolean check at four
 * call sites. See {@link isWhitespaceOnlyChange}.
 */

import {
  tryFormat,
  type ContentLanguage,
} from "@/lib/grid/detectContentType";
import type { Driver, EditorPrefs } from "@/types";

/** The slice of {@link EditorPrefs} this module reads. Narrowed so the tests
 *  can build a three-key object and so the coupling is visible in the type. */
export type AutoFormatPrefs = Pick<
  EditorPrefs,
  "autoFormatJson" | "autoFormatXml" | "autoFormatSql"
>;

/**
 * Size ceilings, above which a cell opens unformatted (the Format button still
 * works — this only gates the automatic path).
 *
 * Not arbitrary caution: `CellPreview` runs this on **every** cell change,
 * including arrow-key navigation, so the cost is paid per keypress while
 * someone walks a column. Re-parsing a multi-megabyte TEXT blob at that rate
 * freezes the window. SQL gets the tighter cap because `sql-formatter` runs a
 * real grammar over the input rather than the one-pass string walk the other
 * two do.
 */
export const AUTO_FORMAT_MAX_BYTES = 256_000;
export const AUTO_FORMAT_MAX_SQL_BYTES = 64_000;

/**
 * Whether the user asked for this language to be formatted on open.
 *
 * Written as an exhaustive switch rather than a lookup so that adding a member
 * to {@link ContentLanguage} is a compile error here — the alternative is a new
 * content type silently defaulting to "never auto-format" and nobody noticing.
 */
export function enabledFor(
  lang: ContentLanguage,
  prefs: AutoFormatPrefs,
): boolean {
  switch (lang) {
    case "json":
      return prefs.autoFormatJson;
    case "xml":
      return prefs.autoFormatXml;
    case "sql":
      return prefs.autoFormatSql;
    case "plaintext":
      // Nothing to format, and no preference offered for it.
      return false;
  }
}

/**
 * True when `b` differs from `a` only in whitespace that sits outside a quoted
 * literal or a CDATA section.
 *
 * **This is the guard that makes auto-formatting safe to save.** `tryFormat`'s
 * JSON branch is a `JSON.parse`/`JSON.stringify` round trip, which is not a
 * whitespace transform at all:
 *
 * - `10000000000000000001` → `10000000000000000000` (an `f64` cannot hold it)
 * - `1.0` → `1`, `1e3` → `1000`
 * - `{"a":1,"a":2}` → one key survives
 * - `{"b":1,"2":2}` → `{"2":2,"b":1}` (integer-like keys are hoisted and sorted)
 * - `"A"` → `"A"`
 *
 * Behind a button that is the user's call. On open, with the result becoming
 * the save baseline, it would mean "open the row with the Snowflake id, press
 * Ctrl+S, silently write a different number". So the automatic path formats,
 * checks, and *discards its own output* when more than whitespace moved.
 *
 * The comparison condenses both sides — dropping whitespace, copying anything
 * inside `"…"`, `'…'` or `<![CDATA[…]]>` verbatim — and compares the results.
 *
 * What this does and does not promise:
 *
 * - **JSON: a complete guarantee.** Whitespace outside string literals is
 *   insignificant in JSON, so identical condensations mean identical values.
 * - **XML: partial, and deliberately so.** It proves no non-whitespace
 *   character was lost, moved or invented, and that attribute values and CDATA
 *   came through untouched. It does *not* prove the whitespace *between*
 *   elements survived — in mixed content that whitespace is itself text. That
 *   is a rewrite `formatXml` has always performed, on this very text, in the
 *   preview panel and behind the Format button; the guard is here to stop the
 *   new failure mode, not to retroactively fix the old one.
 */
export function isWhitespaceOnlyChange(a: string, b: string): boolean {
  return condense(a) === condense(b);
}

/** Strip insignificant whitespace, preserving quoted literals and CDATA. */
function condense(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    // CDATA is literal text: a newline injected inside one is content, not
    // formatting, so copy the whole section through unchanged.
    if (ch === "<" && s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      const stop = end === -1 ? s.length : end + 3;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }

    // Quoted literal: JSON strings and XML attribute values. Copied verbatim,
    // backslash escapes included — `"A"` and `"A"` must not compare equal.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
          out += s[i] + s[i + 1];
          i += 2;
          continue;
        }
        out += s[i];
        i += 1;
        if (s[i - 1] === quote) break;
      }
      continue;
    }

    if (!/\s/.test(ch)) out += ch;
    i += 1;
  }
  return out;
}

/**
 * The single entry point every "a cell just opened" path calls.
 *
 * Returns the text to display, which is either the formatted value or the raw
 * one — never a partial or a failed format, and never a rewrite that changed
 * more than whitespace on the two languages where that is checkable.
 *
 * SQL is exempt from the whitespace check because it *cannot* pass it: the
 * formatter upper-cases keywords by design. That is why the SQL toggle ships
 * off and why its description in Settings says it rewrites the statement rather
 * than only its spacing — an opt-in with the cost stated, instead of a guard
 * that would reject every input.
 */
export function autoFormatOnOpen(
  raw: string,
  lang: ContentLanguage,
  prefs: AutoFormatPrefs,
  driver?: Driver,
): string {
  if (!raw.trim()) return raw;
  if (!enabledFor(lang, prefs)) return raw;

  const cap = lang === "sql" ? AUTO_FORMAT_MAX_SQL_BYTES : AUTO_FORMAT_MAX_BYTES;
  if (raw.length > cap) return raw;

  const formatted = tryFormat(raw, lang, driver);
  if (formatted === raw) return raw;
  if (lang === "sql") return formatted;
  return isWhitespaceOnlyChange(raw, formatted) ? formatted : raw;
}
