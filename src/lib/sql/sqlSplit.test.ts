import { describe, expect, it } from "vitest";
import { splitSql } from "./sqlSplit";

/**
 * Characterization tests for the statement splitter behind the editor's
 * per-statement "▶ Run" CodeLens.
 *
 * Two things are worth pinning here. The lexical contexts — a `;` inside a
 * string, an identifier, a comment or a dollar-quoted body is not a boundary —
 * because getting one wrong splits a statement in half and runs the fragments,
 * which on a `DELETE … WHERE …` is not a syntax error, it is data loss. And
 * the positions, because they feed Monaco directly: 1-based line and column,
 * with `endColumn` one past the last character. An off-by-one there anchors
 * the lens on the wrong statement, and the user runs whatever it points at.
 */

/** Just the texts, for the cases that only care about the split. */
const texts = (sql: string) => splitSql(sql).map((s) => s.text);

describe("splitSql", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(splitSql("")).toEqual([]);
    expect(splitSql("   \n\t  ")).toEqual([]);
  });

  it("splits on top-level semicolons and keeps each terminator", () => {
    expect(texts("SELECT 1; SELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("keeps a trailing statement that has no semicolon", () => {
    expect(texts("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1;", "SELECT 2"]);
  });

  it("drops stray semicolons instead of emitting empty statements", () => {
    expect(texts(";;SELECT 1;;;")).toEqual(["SELECT 1;"]);
  });

  it("treats a document of only comments as no statements", () => {
    expect(splitSql("-- nothing here\n/* nor here */")).toEqual([]);
  });
});

describe("splitSql lexical contexts", () => {
  it("ignores a semicolon inside a single-quoted string", () => {
    expect(texts("SELECT 'a;b'; SELECT 2;")).toEqual([
      "SELECT 'a;b';",
      "SELECT 2;",
    ]);
  });

  it("treats '' as an escape, not a terminator", () => {
    expect(texts("SELECT 'it''s; fine'; SELECT 2;")).toEqual([
      "SELECT 'it''s; fine';",
      "SELECT 2;",
    ]);
  });

  it("ignores a semicolon inside a double-quoted identifier", () => {
    expect(texts('SELECT "we;ird" FROM t; SELECT 2;')).toEqual([
      'SELECT "we;ird" FROM t;',
      "SELECT 2;",
    ]);
  });

  it("ignores a semicolon inside a MySQL backtick identifier", () => {
    expect(texts("SELECT `we;ird` FROM t; SELECT 2;")).toEqual([
      "SELECT `we;ird` FROM t;",
      "SELECT 2;",
    ]);
  });

  it("ignores a semicolon in a line comment", () => {
    expect(texts("SELECT 1 -- ; not a boundary\n; SELECT 2;")).toEqual([
      "SELECT 1 -- ; not a boundary\n;",
      "SELECT 2;",
    ]);
  });

  it("ignores semicolons in a block comment, including across lines", () => {
    expect(texts("SELECT /* a;\nb; */ 1; SELECT 2;")).toEqual([
      "SELECT /* a;\nb; */ 1;",
      "SELECT 2;",
    ]);
  });

  it("ignores semicolons inside a tagged dollar-quoted body", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END; $body$ LANGUAGE plpgsql;\nSELECT 2;";
    expect(texts(sql)).toHaveLength(2);
    expect(texts(sql)[1]).toBe("SELECT 2;");
  });

  it("ignores semicolons inside an empty-tag dollar quote", () => {
    expect(texts("SELECT $$a;b$$; SELECT 2;")).toEqual([
      "SELECT $$a;b$$;",
      "SELECT 2;",
    ]);
  });

  it("does not mistake a bare $ for a dollar quote", () => {
    // `$1` is a Postgres placeholder, not an opening tag — reading it as one
    // would swallow the rest of the document into a string that never closes.
    expect(texts("SELECT $1; SELECT 2;")).toEqual(["SELECT $1;", "SELECT 2;"]);
  });

  it("does not let one dollar tag be closed by a different one", () => {
    expect(texts("SELECT $a$ x$b$ y $a$; SELECT 2;")).toEqual([
      "SELECT $a$ x$b$ y $a$;",
      "SELECT 2;",
    ]);
  });
});

describe("splitSql positions", () => {
  it("reports 1-based positions with endColumn one past the semicolon", () => {
    const [first] = splitSql("SELECT 1;");
    expect(first).toMatchObject({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      text: "SELECT 1;",
    });
  });

  it("anchors on the statement, not on the whitespace or comment before it", () => {
    const [stmt] = splitSql("\n  -- lead-in\n  SELECT 1;");
    expect(stmt).toMatchObject({ startLine: 3, startColumn: 3 });
    expect(stmt!.text).toBe("SELECT 1;");
  });

  it("tracks line numbers across a multi-line statement", () => {
    const [stmt] = splitSql("SELECT\n  1,\n  2;");
    expect(stmt).toMatchObject({
      startLine: 1,
      startColumn: 1,
      endLine: 3,
      endColumn: 5,
    });
  });

  it("counts lines that only exist inside a quoted body", () => {
    const [, second] = splitSql("SELECT 'a\nb';\nSELECT 2;");
    expect(second).toMatchObject({ startLine: 3, startColumn: 1 });
  });

  it("ends an unterminated trailing statement at the last character", () => {
    const [stmt] = splitSql("SELECT 1");
    expect(stmt).toMatchObject({ endLine: 1, endColumn: 9 });
  });
});
