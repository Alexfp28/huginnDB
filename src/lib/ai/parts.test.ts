import { describe, expect, it } from "vitest";

import {
  appendText,
  appendToolCall,
  appendToolResult,
  fenceLanguage,
  isRunnable,
  resultFor,
  splitBlocks,
  toWireMessages,
  type MessagePart,
} from "./parts";

describe("appendText", () => {
  it("coalesces a token stream into one text part", () => {
    let parts: MessagePart[] = [];
    for (const token of ["The ", "table ", "is ", "empty."]) {
      parts = appendText(parts, token);
    }
    expect(parts).toEqual([{ type: "text", text: "The table is empty." }]);
  });

  it("opens a new text part after a tool part rather than reaching past it", () => {
    let parts = appendText([], "Looking…");
    parts = appendToolCall(parts, { id: "c1", name: "list_tables", args: {} });
    parts = appendText(parts, "Found three.");
    expect(parts.map((p) => p.type)).toEqual(["text", "toolCall", "text"]);
    expect(parts[2]).toEqual({ type: "text", text: "Found three." });
  });

  it("ignores an empty delta instead of pushing an empty part", () => {
    const parts = appendText([], "");
    expect(parts).toEqual([]);
    expect(appendText(parts, "")).toBe(parts);
  });

  it("returns a new array, since the store compares by reference", () => {
    const before: MessagePart[] = [{ type: "text", text: "a" }];
    const after = appendText(before, "b");
    expect(after).not.toBe(before);
    expect(before[0]).toEqual({ type: "text", text: "a" });
  });
});

describe("tool parts", () => {
  it("pairs a result with its call by id", () => {
    let parts = appendToolCall([], {
      id: "c1",
      name: "describe_table",
      args: { table: "orders" },
    });
    parts = appendToolCall(parts, { id: "c2", name: "list_tables", args: {} });
    parts = appendToolResult(parts, {
      id: "c2",
      name: "list_tables",
      result: ["orders"],
    });

    expect(resultFor(parts, "c2")?.result).toEqual(["orders"]);
    // The point of appending rather than merging: a card whose result has not
    // arrived still renders, which is what someone watching a slow query needs.
    expect(resultFor(parts, "c1")).toBeUndefined();
  });

  it("carries a refusal as the result's error", () => {
    const parts = appendToolResult([], {
      id: "c1",
      name: "run_query",
      result: null,
      error: "this tool runs read-only statements",
    });
    expect(resultFor(parts, "c1")?.error).toMatch(/read-only/);
  });
});

describe("splitBlocks", () => {
  it("returns plain prose untouched", () => {
    expect(splitBlocks("Just a sentence.")).toEqual([
      { kind: "prose", text: "Just a sentence." },
    ]);
  });

  it("splits prose, a fenced block and trailing prose", () => {
    const blocks = splitBlocks(
      "Try this:\n```sql\nSELECT 1;\n```\nThat is all.",
    );
    expect(blocks).toEqual([
      { kind: "prose", text: "Try this:" },
      { kind: "code", lang: "sql", code: "SELECT 1;", closed: true },
      { kind: "prose", text: "That is all." },
    ]);
  });

  /**
   * The streaming case. An open fence must render as code immediately, or the
   * SQL appears first as prose and reflows into an editor mid-sentence.
   */
  it("reports an unterminated fence as an open code block", () => {
    const blocks = splitBlocks("Here:\n```sql\nSELECT id FROM");
    expect(blocks).toEqual([
      { kind: "prose", text: "Here:" },
      { kind: "code", lang: "sql", code: "SELECT id FROM", closed: false },
    ]);
    // And it must not be offered for execution while half-written.
    expect(isRunnable(blocks[1])).toBe(false);
  });

  it("handles a fence with no language and one with extra info", () => {
    expect(splitBlocks("```\nSELECT 1;\n```")).toEqual([
      { kind: "code", lang: "", code: "SELECT 1;", closed: true },
    ]);
    expect(splitBlocks("```SQL  title=x\nSELECT 1;\n```")[0]).toMatchObject({
      lang: "sql  title=x",
    });
  });

  it("keeps a different fence character as content", () => {
    const blocks = splitBlocks("```\na ~~~ b\n```");
    expect(blocks).toEqual([
      { kind: "code", lang: "", code: "a ~~~ b", closed: true },
    ]);
  });

  it("accepts tilde fences and a longer closing fence", () => {
    expect(splitBlocks("~~~sql\nSELECT 1;\n~~~~")).toEqual([
      { kind: "code", lang: "sql", code: "SELECT 1;", closed: true },
    ]);
  });

  it("drops whitespace-only prose between two blocks", () => {
    const blocks = splitBlocks("```\na\n```\n\n```\nb\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["code", "code"]);
  });

  it("keeps two blocks separate rather than fusing them", () => {
    const blocks = splitBlocks("```sql\nSELECT 1;\n```\nand\n```sql\nSELECT 2;\n```");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ code: "SELECT 1;" });
    expect(blocks[2]).toMatchObject({ code: "SELECT 2;" });
  });
});

describe("fenceLanguage", () => {
  it("maps every SQL dialect a model might label onto sql", () => {
    for (const lang of ["sql", "mysql", "postgres", "postgresql", "psql", "sqlite", "tsql", "mssql"]) {
      expect(fenceLanguage(lang)).toBe("sql");
    }
  });

  /** A bare fence from a model asked about a database is SQL far more often
   *  than not, and being wrong costs colouring rather than correctness. */
  it("treats a fence with no language as sql", () => {
    expect(fenceLanguage("")).toBe("sql");
  });

  it("maps mongosh's several spellings onto javascript", () => {
    for (const lang of ["js", "javascript", "mongo", "mongodb", "mongosh"]) {
      expect(fenceLanguage(lang)).toBe("javascript");
    }
  });

  it("returns null for anything it cannot highlight as a statement", () => {
    for (const lang of ["python", "rust", "bash", "text", "diff"]) {
      expect(fenceLanguage(lang)).toBeNull();
    }
  });
});

describe("isRunnable", () => {
  it("accepts a closed sql or mongosh block with content", () => {
    expect(
      isRunnable({ kind: "code", lang: "sql", code: "SELECT 1", closed: true }),
    ).toBe(true);
    expect(
      isRunnable({
        kind: "code",
        lang: "mongosh",
        code: "db.a.find({})",
        closed: true,
      }),
    ).toBe(true);
  });

  it("refuses prose, an open fence, an empty block and a foreign language", () => {
    expect(isRunnable({ kind: "prose", text: "SELECT 1" })).toBe(false);
    expect(
      isRunnable({ kind: "code", lang: "sql", code: "SELECT 1", closed: false }),
    ).toBe(false);
    expect(
      isRunnable({ kind: "code", lang: "sql", code: "   \n ", closed: true }),
    ).toBe(false);
    expect(
      isRunnable({ kind: "code", lang: "python", code: "print(1)", closed: true }),
    ).toBe(false);
  });
});

describe("toWireMessages", () => {
  const message = (
    id: string,
    role: "user" | "assistant",
    parts: MessagePart[],
  ) => ({ id, role, parts });

  it("flattens each message's text parts into one content string", () => {
    expect(
      toWireMessages([
        message("1", "user", [{ type: "text", text: "which tables?" }]),
        message("2", "assistant", [
          { type: "text", text: "Let me look. " },
          { type: "text", text: "Three." },
        ]),
      ]),
    ).toEqual([
      { role: "user", content: "which tables?" },
      { role: "assistant", content: "Let me look. Three." },
    ]);
  });

  /** Several servers reject a request containing an empty message, and both of
   *  these are states the panel really produces: a turn cancelled before its
   *  first token, and (from phase 6) a turn that only called tools. */
  it("drops messages with no text", () => {
    expect(
      toWireMessages([
        message("1", "user", [{ type: "text", text: "hi" }]),
        message("2", "assistant", []),
        message("3", "assistant", [
          { type: "toolCall", id: "c1", name: "list_tables", args: {} },
        ]),
        message("4", "assistant", [{ type: "text", text: "   " }]),
      ]),
    ).toEqual([{ role: "user", content: "hi" }]);
  });

  /** The cap protects the smallest endpoint this feature targets: past it a
   *  server truncates or errors, and both look like the assistant losing its
   *  mind rather than running out of room. */
  it("keeps the newest messages when the history is longer than the cap", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      message(String(i), i % 2 === 0 ? "user" : "assistant", [
        { type: "text", text: `m${i}` },
      ]),
    );
    const wire = toWireMessages(many, 4);
    expect(wire.map((m) => m.content)).toEqual(["m26", "m27", "m28", "m29"]);
  });
});
