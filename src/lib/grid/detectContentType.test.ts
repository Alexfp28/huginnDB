import { describe, expect, it } from "vitest";

import { detectLanguage, tryFormat } from "./detectContentType";

describe("detectLanguage", () => {
  it("recognises JSON objects and arrays that actually parse", () => {
    expect(detectLanguage('{"a":1}')).toBe("json");
    expect(detectLanguage("[1,2,3]")).toBe("json");
    expect(detectLanguage("  \n {\"a\": 1}  ")).toBe("json");
  });

  it("does not call something JSON just because it starts with a brace", () => {
    // Bracket-matched but not parseable — the heuristic checks both.
    expect(detectLanguage("{a:1}")).toBe("plaintext");
    // Unclosed: never reaches the parse attempt.
    expect(detectLanguage('{"a":1')).toBe("plaintext");
  });

  it("recognises XML", () => {
    expect(detectLanguage("<root><a>1</a></root>")).toBe("xml");
    expect(detectLanguage("<a/>")).toBe("xml");
  });

  it("does not call a bare comparison XML", () => {
    expect(detectLanguage("<3")).toBe("plaintext");
    // Angle-wrapped but with nothing tag-shaped inside.
    expect(detectLanguage("<3 and 4>")).toBe("plaintext");
  });

  it("recognises SQL by its leading verb", () => {
    expect(detectLanguage("select * from t")).toBe("sql");
    expect(detectLanguage("  UPDATE t SET a = 1")).toBe("sql");
    expect(detectLanguage("create table t (id int)")).toBe("sql");
  });

  it("requires a word boundary after the verb", () => {
    // The `\b` is what keeps a CSS-ish string out of the SQL branch. Worth
    // pinning: without it, plenty of ordinary text starts with these letters.
    expect(detectLanguage("SELECTOR .foo { }")).toBe("plaintext");
    expect(detectLanguage("updated_at")).toBe("plaintext");
  });

  it("calls empty content plaintext", () => {
    expect(detectLanguage("")).toBe("plaintext");
    expect(detectLanguage("   ")).toBe("plaintext");
  });
});

describe("tryFormat", () => {
  it("pretty-prints JSON", () => {
    expect(tryFormat('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
  });

  it("returns the value unchanged when JSON does not parse", () => {
    expect(tryFormat("{nope", "json")).toBe("{nope");
  });

  it("indents XML", () => {
    expect(tryFormat("<a><b>1</b></a>", "xml")).toContain("\n");
  });

  /**
   * A behaviour change: the `sql` branch used to return its input verbatim
   * because the repo had no SQL formatter. It now delegates to
   * `sql-formatter`, which is what the "auto-format SQL on open" preference
   * needs to exist at all.
   */
  it("now formats SQL, which it previously returned untouched", () => {
    const out = tryFormat("select a from t", "sql");
    expect(out).not.toBe("select a from t");
    expect(out).toContain("SELECT");
  });

  it("uses the driver's dialect for SQL when given one", () => {
    expect(() => tryFormat("select 1", "sql", "sqlserver")).not.toThrow();
    expect(tryFormat("select 1", "sql", "mysql")).toContain("SELECT");
  });

  it("leaves plaintext alone", () => {
    expect(tryFormat("hello world", "plaintext")).toBe("hello world");
  });
});
