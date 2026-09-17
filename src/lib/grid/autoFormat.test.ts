import { describe, expect, it } from "vitest";

import {
  AUTO_FORMAT_MAX_SQL_BYTES,
  AUTO_FORMAT_MAX_BYTES,
  autoFormatOnOpen,
  enabledFor,
  isWhitespaceOnlyChange,
  type AutoFormatPrefs,
} from "./autoFormat";

const ALL_OFF: AutoFormatPrefs = {
  autoFormatJson: false,
  autoFormatXml: false,
  autoFormatSql: false,
};
const only = (k: keyof AutoFormatPrefs): AutoFormatPrefs => ({
  ...ALL_OFF,
  [k]: true,
});

const JSON_CELL = '{"a":1,"b":[2,3]}';
const XML_CELL = "<root><a>1</a><b>2</b></root>";
const SQL_CELL = "select id, name from users where id = 1";

describe("enabledFor", () => {
  it("maps each language to its own switch", () => {
    expect(enabledFor("json", only("autoFormatJson"))).toBe(true);
    expect(enabledFor("xml", only("autoFormatXml"))).toBe(true);
    expect(enabledFor("sql", only("autoFormatSql"))).toBe(true);
  });

  it("never formats plaintext, whatever is switched on", () => {
    expect(
      enabledFor("plaintext", {
        autoFormatJson: true,
        autoFormatXml: true,
        autoFormatSql: true,
      }),
    ).toBe(false);
  });
});

/**
 * The headline requirement, in David's words: someone who only wants JSON
 * auto-formatted must not get their XML or their SQL rewritten too. Each of
 * these asserts byte-identity on the two types that were left off, which is
 * the only assertion that actually proves independence.
 */
describe("autoFormatOnOpen — one type at a time", () => {
  it("formats JSON and leaves XML and SQL byte-identical", () => {
    const prefs = only("autoFormatJson");
    expect(autoFormatOnOpen(JSON_CELL, "json", prefs)).toContain("\n");
    expect(autoFormatOnOpen(XML_CELL, "xml", prefs)).toBe(XML_CELL);
    expect(autoFormatOnOpen(SQL_CELL, "sql", prefs)).toBe(SQL_CELL);
  });

  it("formats XML and leaves JSON and SQL byte-identical", () => {
    const prefs = only("autoFormatXml");
    expect(autoFormatOnOpen(XML_CELL, "xml", prefs)).toContain("\n");
    expect(autoFormatOnOpen(JSON_CELL, "json", prefs)).toBe(JSON_CELL);
    expect(autoFormatOnOpen(SQL_CELL, "sql", prefs)).toBe(SQL_CELL);
  });

  it("formats SQL and leaves JSON and XML byte-identical", () => {
    const prefs = only("autoFormatSql");
    expect(autoFormatOnOpen(SQL_CELL, "sql", prefs)).toContain("\n");
    expect(autoFormatOnOpen(JSON_CELL, "json", prefs)).toBe(JSON_CELL);
    expect(autoFormatOnOpen(XML_CELL, "xml", prefs)).toBe(XML_CELL);
  });

  it("touches nothing with every switch off", () => {
    expect(autoFormatOnOpen(JSON_CELL, "json", ALL_OFF)).toBe(JSON_CELL);
    expect(autoFormatOnOpen(XML_CELL, "xml", ALL_OFF)).toBe(XML_CELL);
    expect(autoFormatOnOpen(SQL_CELL, "sql", ALL_OFF)).toBe(SQL_CELL);
  });
});

describe("autoFormatOnOpen — bail-outs", () => {
  it("returns empty and whitespace-only input untouched", () => {
    const prefs = only("autoFormatJson");
    expect(autoFormatOnOpen("", "json", prefs)).toBe("");
    expect(autoFormatOnOpen("   \n ", "json", prefs)).toBe("   \n ");
  });

  it("leaves plaintext alone", () => {
    expect(
      autoFormatOnOpen("just some words", "plaintext", {
        autoFormatJson: true,
        autoFormatXml: true,
        autoFormatSql: true,
      }),
    ).toBe("just some words");
  });

  it("skips a value over the size cap", () => {
    // Valid JSON, but past the ceiling: formatting it on every arrow-key move
    // through a column is what the cap exists to prevent.
    const huge = `{"a":"${"x".repeat(AUTO_FORMAT_MAX_BYTES)}"}`;
    expect(autoFormatOnOpen(huge, "json", only("autoFormatJson"))).toBe(huge);
  });

  it("caps SQL tighter than JSON", () => {
    expect(AUTO_FORMAT_MAX_SQL_BYTES).toBeLessThan(AUTO_FORMAT_MAX_BYTES);
    const big = "select " + "a,".repeat(AUTO_FORMAT_MAX_SQL_BYTES / 2) + "b";
    expect(autoFormatOnOpen(big, "sql", only("autoFormatSql"))).toBe(big);
  });
});

/**
 * The reason this module exists rather than a boolean at the call sites.
 *
 * Each of these is a `JSON.parse`/`stringify` round trip that changes the
 * VALUE, not the whitespace. Because the formatted text becomes the editor's
 * save baseline, formatting them on open and then pressing Ctrl+S would write
 * a different value than the database holds — silently. They must all come
 * back raw.
 */
describe("autoFormatOnOpen — refuses a lossy reformat", () => {
  const prefs = only("autoFormatJson");

  it("keeps an integer too large for an f64", () => {
    const raw = '{"id":10000000000000000001}';
    expect(autoFormatOnOpen(raw, "json", prefs)).toBe(raw);
  });

  it("keeps a trailing-zero float and an exponent", () => {
    expect(autoFormatOnOpen('{"a":1.0}', "json", prefs)).toBe('{"a":1.0}');
    expect(autoFormatOnOpen('{"a":1e3}', "json", prefs)).toBe('{"a":1e3}');
  });

  it("keeps duplicate keys rather than dropping one", () => {
    const raw = '{"a":1,"a":2}';
    expect(autoFormatOnOpen(raw, "json", prefs)).toBe(raw);
  });

  it("keeps integer-like keys in their original order", () => {
    // `JSON.stringify` hoists "2" ahead of "b" — a reordering that is not a
    // whitespace change however much it looks like one.
    const raw = '{"b":1,"2":2}';
    expect(autoFormatOnOpen(raw, "json", prefs)).toBe(raw);
  });

  it("keeps a unicode escape unexpanded", () => {
    const raw = '{"a":"\\u0041"}';
    expect(autoFormatOnOpen(raw, "json", prefs)).toBe(raw);
  });

  it("still formats the ordinary case", () => {
    const out = autoFormatOnOpen(JSON_CELL, "json", prefs);
    expect(out).not.toBe(JSON_CELL);
    expect(JSON.parse(out)).toEqual({ a: 1, b: [2, 3] });
  });

  it("leaves invalid JSON alone instead of erroring", () => {
    const raw = '{"a": ';
    expect(autoFormatOnOpen(raw, "json", prefs)).toBe(raw);
  });
});

describe("isWhitespaceOnlyChange", () => {
  it("accepts indentation added outside literals", () => {
    expect(isWhitespaceOnlyChange('{"a":1}', '{\n  "a": 1\n}')).toBe(true);
  });

  it("rejects a changed number", () => {
    expect(isWhitespaceOnlyChange('{"a":1.0}', '{"a":1}')).toBe(false);
  });

  it("rejects whitespace added inside a string literal", () => {
    expect(isWhitespaceOnlyChange('{"a":"x y"}', '{"a":"x  y"}')).toBe(false);
  });

  it("rejects whitespace injected into a CDATA section", () => {
    // `formatXml` splits on `><`, which can land inside CDATA content — where
    // a newline is text, not formatting.
    expect(
      isWhitespaceOnlyChange(
        "<a><![CDATA[x><y]]></a>",
        "<a><![CDATA[x>\n<y]]></a>",
      ),
    ).toBe(false);
  });

  it("treats an unterminated literal as literal to the end", () => {
    expect(isWhitespaceOnlyChange('{"a":"x', '{"a":"x')).toBe(true);
  });
});

describe("autoFormatOnOpen — idempotence", () => {
  // The property `preformatted` exists to protect: running the formatter over
  // its own output must not keep changing it.
  it("is idempotent for JSON", () => {
    const prefs = only("autoFormatJson");
    const once = autoFormatOnOpen(JSON_CELL, "json", prefs);
    expect(autoFormatOnOpen(once, "json", prefs)).toBe(once);
  });

  it("is idempotent for SQL", () => {
    const prefs = only("autoFormatSql");
    const once = autoFormatOnOpen(SQL_CELL, "sql", prefs);
    expect(autoFormatOnOpen(once, "sql", prefs)).toBe(once);
  });

  /**
   * XML is the one that is NOT idempotent, and this pins it deliberately
   * rather than asserting the behaviour we would prefer.
   *
   * `formatXml` splits on `><`, which its own indented output no longer
   * contains, and its closing-tag test `/^<\/.+>/` does not match a line with
   * leading spaces — so a second pass indents differently from the first. This
   * is the concrete reason `CellEditorTarget.preformatted` exists: the modal's
   * "move to side panel" hands over a buffer that has already been through
   * here, and running it again would drift.
   *
   * If someone rewrites `formatXml` on a real parser this assertion will fail,
   * which is the correct outcome — flipping it to `toBe` is then the fix.
   */
  it("is NOT idempotent for XML — the reason `preformatted` exists", () => {
    const prefs = only("autoFormatXml");
    const once = autoFormatOnOpen(XML_CELL, "xml", prefs);
    const twice = autoFormatOnOpen(once, "xml", prefs);
    expect(twice).not.toBe(once);
  });
});
