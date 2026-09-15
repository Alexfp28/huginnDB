import { describe, expect, it } from "vitest";

import { quoteIdent, selectSnippet, sqlLiteral, toBulk } from "./copyFormats";

describe("quoteIdent", () => {
  it("uses each driver's conventional delimiters", () => {
    expect(quoteIdent("mysql", "users")).toBe("`users`");
    expect(quoteIdent("sqlserver", "users")).toBe("[users]");
    expect(quoteIdent("postgres", "users")).toBe('"users"');
    expect(quoteIdent("sqlite", "users")).toBe('"users"');
    // An unknown/absent driver falls back to ANSI double quotes.
    expect(quoteIdent(undefined, "users")).toBe('"users"');
  });

  // The regression this module exists to prevent: a name that contains its own
  // delimiter has to double it, or the emitted SQL does not parse.
  it("doubles an embedded delimiter", () => {
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("sqlserver", "a]b")).toBe("[a]]b]");
  });

  it("leaves a foreign delimiter alone", () => {
    // A backtick is not special to Postgres, so it must survive untouched
    // rather than being escaped as if it were.
    expect(quoteIdent("postgres", "a`b")).toBe('"a`b"');
    expect(quoteIdent("mysql", 'a"b')).toBe('`a"b`');
  });
});

describe("selectSnippet", () => {
  it("qualifies with the schema when there is one", () => {
    expect(selectSnippet("postgres", "public", "users")).toBe(
      'SELECT * FROM "public"."users";',
    );
    expect(selectSnippet("mysql", "shop", "orders")).toBe(
      "SELECT * FROM `shop`.`orders`;",
    );
    expect(selectSnippet("sqlserver", "dbo", "Users")).toBe(
      "SELECT * FROM [dbo].[Users];",
    );
  });

  it("omits an absent or empty schema", () => {
    expect(selectSnippet("sqlite", undefined, "users")).toBe(
      'SELECT * FROM "users";',
    );
    expect(selectSnippet("sqlite", "", "users")).toBe('SELECT * FROM "users";');
  });

  // This is the bug the snippet was moved here to fix: the schema tree used to
  // build the string with its own quoting, which did not escape.
  it("escapes embedded delimiters in both parts", () => {
    expect(selectSnippet("postgres", 'we"ird', 'a"b')).toBe(
      'SELECT * FROM "we""ird"."a""b";',
    );
  });

  it("emits a mongosh find() for MongoDB, which has no SQL", () => {
    expect(selectSnippet("mongodb", undefined, "events")).toBe(
      "db.events.find({}).limit(100)",
    );
    // The database name is already bound by the connection, so a Mongo snippet
    // never qualifies — passing one must not change the output.
    expect(selectSnippet("mongodb", "shop", "events")).toBe(
      "db.events.find({}).limit(100)",
    );
  });

  // The limited form is what the schema tree's "Query this table…" runs, as
  // opposed to what "Copy SELECT statement" puts on the clipboard.
  describe("with a limit", () => {
    it("appends LIMIT on the three drivers that have it", () => {
      expect(selectSnippet("postgres", "public", "users", 100)).toBe(
        'SELECT * FROM "public"."users" LIMIT 100;',
      );
      expect(selectSnippet("mysql", "shop", "orders", 100)).toBe(
        "SELECT * FROM `shop`.`orders` LIMIT 100;",
      );
      expect(selectSnippet("sqlite", undefined, "users", 100)).toBe(
        'SELECT * FROM "users" LIMIT 100;',
      );
    });

    // T-SQL has no LIMIT, and `OFFSET … FETCH NEXT` would need an ORDER BY
    // there is none to supply.
    it("uses TOP n on SQL Server", () => {
      expect(selectSnippet("sqlserver", "dbo", "Users", 100)).toBe(
        "SELECT TOP 100 * FROM [dbo].[Users];",
      );
    });

    it("threads the limit into MongoDB's own find().limit()", () => {
      expect(selectSnippet("mongodb", undefined, "events", 50)).toBe(
        "db.events.find({}).limit(50)",
      );
    });

    it("leaves the unlimited form exactly as it was", () => {
      expect(selectSnippet("postgres", "public", "users")).toBe(
        'SELECT * FROM "public"."users";',
      );
    });

    it("still escapes embedded delimiters", () => {
      expect(selectSnippet("postgres", 'we"ird', 'a"b', 10)).toBe(
        'SELECT * FROM "we""ird"."a""b" LIMIT 10;',
      );
    });
  });
});

describe("sqlLiteral", () => {
  it("inlines numbers and booleans, quotes strings, keeps NULL", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(true)).toBe("true");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral("hi")).toBe("'hi'");
  });

  it("doubles an embedded single quote", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("stringifies an object before quoting", () => {
    expect(sqlLiteral({ a: 1 })).toBe("'{\"a\":1}'");
  });

  // Regression: MySQL treats `\` as a string-literal escape character by
  // default, so a pasted-back snippet silently dropped it (`DOMAIN\user`
  // became `DOMAINuser`) unless the backslash is itself doubled.
  it("escapes a backslash for MySQL but not for other drivers", () => {
    expect(sqlLiteral("DOMAIN\\user", "mysql")).toBe("'DOMAIN\\\\user'");
    expect(sqlLiteral("DOMAIN\\user", "postgres")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user", "sqlserver")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user", "sqlite")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user")).toBe("'DOMAIN\\user'");
  });
});

describe("toBulk", () => {
  const columns = [
    { name: "id", data_type: "int" },
    { name: "note", data_type: "text" },
  ];
  const rows = [
    [1, "first"],
    [2, null],
  ];

  it("yields one JSON array for the whole selection", () => {
    expect(JSON.parse(toBulk(rows, "json", { columns, driver: "postgres" }))).toEqual([
      { id: 1, note: "first" },
      { id: 2, note: null },
    ]);
  });

  it("normalises a BigInt instead of throwing", () => {
    // The old inline copy in `DataGrid` cast values straight in, so a BigInt
    // copied fine as one row and threw the moment two rows were selected.
    const withBig = [[1n as unknown as number, "x"]];
    expect(toBulk(withBig, "json", { columns, driver: "postgres" })).toContain('"1"');
  });

  it("newline-joins one statement per row", () => {
    const sql = toBulk(rows, "insert", {
      columns,
      driver: "postgres",
      tableName: "notes",
    });
    expect(sql.split("\n")).toHaveLength(2);
    expect(sql).toContain('INSERT INTO "notes"');
  });
});
