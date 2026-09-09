import { describe, expect, it } from "vitest";

import { parseInline, parseProse } from "./markdown";

describe("parseInline", () => {
  it("returns plain text as one run", () => {
    expect(parseInline("just words")).toEqual([
      { kind: "text", text: "just words" },
    ]);
  });

  it("reads bold, italic, strike and code", () => {
    expect(parseInline("**b**")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
    ]);
    expect(parseInline("__b__")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
    ]);
    expect(parseInline("*i*")).toEqual([
      { kind: "em", children: [{ kind: "text", text: "i" }] },
    ]);
    expect(parseInline("~~s~~")).toEqual([
      { kind: "strike", children: [{ kind: "text", text: "s" }] },
    ]);
    expect(parseInline("`c`")).toEqual([{ kind: "code", text: "c" }]);
  });

  /** Priority at the same index is the whole reason the patterns are a list. */
  it("does not read bold as two italics", () => {
    expect(parseInline("**bold**")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
    ]);
  });

  it("nests, so bold containing italic survives", () => {
    expect(parseInline("**a *b* c**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "a " },
          { kind: "em", children: [{ kind: "text", text: "b" }] },
          { kind: "text", text: " c" },
        ],
      },
    ]);
  });

  /** Code content is literal: a backtick span is never re-parsed. */
  it("leaves markup inside code alone", () => {
    expect(parseInline("`a ** b`")).toEqual([{ kind: "code", text: "a ** b" }]);
  });

  /**
   * The failure that would have shown up on the very first schema question: a
   * database assistant writes `snake_case` names constantly, and a naive `_`
   * rule italicises half of them.
   */
  it("does not italicise snake_case identifiers", () => {
    expect(parseInline("use ai_skill_config here")).toEqual([
      { kind: "text", text: "use ai_skill_config here" },
    ]);
    expect(parseInline("table_name and other_name")).toEqual([
      { kind: "text", text: "table_name and other_name" },
    ]);
    // A real `_emphasis_` between word boundaries still works.
    expect(parseInline("that is _really_ slow")).toEqual([
      { kind: "text", text: "that is " },
      { kind: "em", children: [{ kind: "text", text: "really" }] },
      { kind: "text", text: " slow" },
    ]);
  });

  it("keeps text around a run", () => {
    expect(parseInline("a **b** c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " c" },
    ]);
  });

  it("parses a link's text and target without making it an anchor", () => {
    expect(parseInline("see [docs](https://x.dev/a)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "docs", href: "https://x.dev/a" },
    ]);
  });

  /** Untrusted output: HTML is text, never markup. */
  it("treats raw HTML as text", () => {
    expect(parseInline("<b>x</b>")).toEqual([
      { kind: "text", text: "<b>x</b>" },
    ]);
  });
});

describe("parseProse", () => {
  it("joins hard-wrapped lines into one paragraph", () => {
    expect(parseProse("one line\nand its wrap\n\nsecond")).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "one line and its wrap" }] },
      { kind: "paragraph", content: [{ kind: "text", text: "second" }] },
    ]);
  });

  it("reads an ordered list and keeps its starting number", () => {
    const blocks = parseProse("1. first\n2. second");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          [{ kind: "text", text: "first" }],
          [{ kind: "text", text: "second" }],
        ],
      },
    ]);
    expect(parseProse("3. third")[0]).toMatchObject({ start: 3 });
  });

  it("reads a bulleted list under any of its markers", () => {
    for (const marker of ["-", "*", "+"]) {
      expect(parseProse(`${marker} one\n${marker} two`)).toEqual([
        {
          kind: "list",
          ordered: false,
          start: 1,
          items: [
            [{ kind: "text", text: "one" }],
            [{ kind: "text", text: "two" }],
          ],
        },
      ]);
    }
  });

  /** The shape the screenshot showed: a numbered list of bolded points. */
  it("keeps inline markup inside list items", () => {
    expect(parseProse("1. **Write SQL**: I can draft queries.")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          [
            { kind: "strong", children: [{ kind: "text", text: "Write SQL" }] },
            { kind: "text", text: ": I can draft queries." },
          ],
        ],
      },
    ]);
  });

  it("folds a wrapped bullet into its own item", () => {
    const blocks = parseProse("- a long item\n  that wrapped\n- second");
    expect(blocks[0]).toMatchObject({
      items: [
        [{ kind: "text", text: "a long item that wrapped" }],
        [{ kind: "text", text: "second" }],
      ],
    });
  });

  it("does not fuse an ordered list into a bulleted one", () => {
    const blocks = parseProse("- a\n1. b");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ ordered: false });
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it("reads headings and clamps them to three levels", () => {
    expect(parseProse("# One")).toEqual([
      { kind: "heading", level: 1, content: [{ kind: "text", text: "One" }] },
    ]);
    expect(parseProse("###### Deep")[0]).toMatchObject({ level: 3 });
    // A `#` with no space is not a heading; it is a comment, or a column name.
    expect(parseProse("#nothashtag")[0]).toMatchObject({ kind: "paragraph" });
  });

  it("reads quotes and rules", () => {
    expect(parseProse("> quoted")).toEqual([
      { kind: "quote", content: [{ kind: "text", text: "quoted" }] },
    ]);
    expect(parseProse("---")).toEqual([{ kind: "rule" }]);
    expect(parseProse("***")).toEqual([{ kind: "rule" }]);
  });

  it("returns nothing for empty or blank input", () => {
    expect(parseProse("")).toEqual([]);
    expect(parseProse("\n\n  \n")).toEqual([]);
  });
});
