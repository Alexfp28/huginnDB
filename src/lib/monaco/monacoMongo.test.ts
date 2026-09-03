import { describe, expect, it } from "vitest";
import { ensureMongoLanguage, registerMongoEditor, type MongoCompletionEntry } from "./monacoMongo";

/**
 * End-to-end characterization of the completion provider itself, against a
 * minimal hand-rolled Monaco stand-in.
 *
 * `completionContext.test.ts` already pins the cursor-position scanner in
 * isolation, but a real regression (accumulator suggestions missing for a
 * $group output field, reported against the exact shape below) showed that
 * isn't enough — the bug could just as easily live in how `monacoMongo.ts`
 * wires that context into `provideCompletionItems`, which nothing exercised
 * end to end. This mocks only the pieces the provider actually calls: word
 * boundary, one line's text, the full buffer, and an offset↔position
 * conversion — all derived from a single flat string, matching how the real
 * Monaco model would answer for the same text.
 */

interface Position {
  lineNumber: number;
  column: number;
}

function linesOf(text: string) {
  return text.split("\n");
}

function positionAt(text: string, offset: number): Position {
  const upTo = text.slice(0, offset);
  const lines = linesOf(upTo);
  return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
}

function offsetAt(text: string, position: Position): number {
  const lines = linesOf(text);
  let offset = 0;
  for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1;
  return offset + position.column - 1;
}

/** Mirrors Monaco's default word pattern for this language: a word is
 *  `[A-Za-z0-9_]+` — `$` is a separator, matching the comments in
 *  `monacoMongo.ts` that rely on exactly this boundary. */
function wordUntilPosition(text: string, position: Position) {
  const line = linesOf(text)[position.lineNumber - 1];
  const col = position.column - 1;
  let start = col;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start -= 1;
  return { word: line.slice(start, col), startColumn: start + 1, endColumn: col + 1 };
}

/** A model whose buffer ends exactly at the cursor — safe because nothing in
 *  the provider ever looks past `offset` (same guarantee `completionContext`
 *  gives its own caller). */
function mockModel(text: string) {
  return {
    getWordUntilPosition: (position: Position) => wordUntilPosition(text, position),
    getValueInRange: (range: {
      startLineNumber: number;
      startColumn: number;
      endColumn: number;
    }) => linesOf(text)[range.startLineNumber - 1].slice(range.startColumn - 1, range.endColumn - 1),
    getValue: () => text,
    getOffsetAt: (position: Position) => offsetAt(text, position),
    uri: { toString: () => "test://model" },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockMonaco(): { monaco: any; getProvider: () => any } {
  let provider: unknown;
  const monaco = {
    languages: {
      register: () => {},
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: () => {},
      registerCompletionItemProvider: (_id: string, p: unknown) => {
        provider = p;
      },
      CompletionItemKind: {
        Snippet: 1,
        Function: 2,
        Constructor: 3,
        Field: 4,
        Class: 5,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  };
  return { monaco, getProvider: () => provider };
}

function complete(
  text: string,
  opts: { triggerCharacter?: string; entry?: MongoCompletionEntry } = {},
) {
  const { monaco, getProvider } = mockMonaco();
  ensureMongoLanguage(monaco);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = getProvider() as any;
  const model = mockModel(text);
  let unregister: (() => void) | undefined;
  if (opts.entry) unregister = registerMongoEditor(model.uri.toString(), opts.entry);
  try {
    const position = positionAt(text, text.length);
    const result = provider.provideCompletionItems(model, position, {
      triggerCharacter: opts.triggerCharacter,
    });
    return result.suggestions as {
      label: string;
      insertText: string;
      detail?: string;
    }[];
  } finally {
    unregister?.();
  }
}

describe("provideCompletionItems: $group accumulator field", () => {
  it("offers $sum for a fresh, brace-less output field", () => {
    const text = '{\n  $group: {\n    _id: "$field",\n    count: $su';
    const labels = complete(text).map((s) => s.label);
    expect(labels).toContain("$sum");
  });

  it("offers $sum inside an already-open output field object (the reported bug)", () => {
    // Exactly the shape from the screenshot: the $group snippet's own
    // accumulator tabstop already opened `{ }`, and the user is typing over
    // its placeholder — completionPositionAt reports this one frame deeper
    // than the bare case above (key "count", parent "$group"), which is the
    // distinction the fix added.
    const text = '{\n  $group: {\n    _id: "$Item",\n    count: { $s';
    const suggestions = complete(text);
    const sum = suggestions.find((s) => s.label === "$sum");
    expect(sum).toBeDefined();
    // Bare fragment, no extra wrapping braces — they're already there.
    expect(sum!.insertText).toBe("\\$sum: ${1:1}");
  });

  it("never offers $sum for $group's own _id", () => {
    const text = '{\n  $group: {\n    _id: $s';
    const labels = complete(text).map((s) => s.label);
    expect(labels).not.toContain("$sum");
  });

  it("does not offer stage names ($match, …) inside a nested accumulator slot", () => {
    const text = '{\n  $group: {\n    _id: "$field",\n    count: { $m';
    const suggestions = complete(text);
    expect(suggestions.some((s) => s.detail === "stage")).toBe(false);
  });

  it("offers $sum for $bucket's output field, wrapped under output:", () => {
    const text =
      '{\n  $bucket: {\n    groupBy: "$field",\n    boundaries: [0, 10],\n    output: {\n      total: { $s';
    const labels = complete(text).map((s) => s.label);
    expect(labels).toContain("$sum");
  });
});

describe("provideCompletionItems: stage operators", () => {
  it("offers stage names at a fresh stage body's own top-level key", () => {
    const text = "{\n  $gro";
    const labels = complete(text).map((s) => s.label);
    expect(labels).toContain("$group");
  });

  it("does not offer stage names once inside a nested value ($match's own filter)", () => {
    const text = '{\n  $match: {\n    field: "$f';
    const suggestions = complete(text);
    expect(suggestions.some((s) => s.detail === "stage")).toBe(false);
  });
});

describe("provideCompletionItems: expression operators are keys, not values", () => {
  it("does not offer generic expression operators for $group's own _id value", () => {
    // The bug reported against this exact position: $group's `_id: "$field"`
    // is a plain field reference, and the ~50-entry expression-operator list
    // (`$concat`, `$cond`, …) buried the one thing that actually belongs
    // here — a real collection field name — under operator noise. An
    // operator is always a key ({ $concat: [...] }), never a bare value.
    const text = '{\n  $group: {\n    _id: "$';
    const suggestions = complete(text);
    expect(suggestions.some((s) => s.detail === "expression")).toBe(false);
  });

  it("still offers a BSON constructor at that same value position", () => {
    // Unlike an operator, ObjectId(...)/ISODate(...) *are* legitimate bare
    // values, so they must not be swept out along with the operators.
    const text = '{\n  $group: {\n    _id: "$';
    const suggestions = complete(text);
    expect(suggestions.some((s) => s.detail === "BSON")).toBe(true);
  });

  it("still offers expression operators once a nested expression object is opened", () => {
    // $project: { total: { $| } } — a fresh `{` was just opened for
    // "total"'s value, so the cursor is choosing that object's own key, not
    // a bare value; the operator list belongs here.
    const text = '{\n  $project: {\n    total: { $';
    const labels = complete(text).map((s) => s.label);
    expect(labels).toContain("$concat");
  });

  it("does not offer expression operators for a plain field-reference value outside $group", () => {
    const text = '{\n  $addFields: {\n    newField: "$';
    const suggestions = complete(text);
    expect(suggestions.some((s) => s.detail === "expression")).toBe(false);
  });
});

describe("provideCompletionItems: a field suggestion's label must match the range it replaces", () => {
  const entry: MongoCompletionEntry = {
    getCollections: () => ["orders"],
    sourceCollection: () => "orders",
    getFields: (name) => (name === "orders" ? ["entity", "entityId", "price"] : undefined),
    requestFields: () => {},
  };

  it("prefixes a $-value field suggestion's label with $, not just its insertText", () => {
    // The reported bug: this position (typing "$en" inside $group's own
    // `_id: "$|"`) replaces a range that includes the leading `$`
    // (`dollarRange`), but the field suggestions used a bare `label: f`.
    // Monaco filters each item by testing its OWN label against whatever
    // text `range` spans — "$en" never fuzzy-matches "entity" (there is no
    // `$` in it) — so the item was silently dropped by Monaco itself before
    // it reached the widget, even though the provider had already returned
    // it with a perfectly correct `insertText: "$entity"`. The label has to
    // carry the same `$` prefix as the text actually being replaced.
    const text = '{\n  $group: {\n    _id: "$en';
    const suggestions = complete(text, { entry });
    const entity = suggestions.find((s) => s.insertText === "$entity");
    expect(entity).toBeDefined();
    expect(entity!.label).toBe("$entity");
  });

  it("leaves a bare (no $) field suggestion's label untouched", () => {
    // The $lookup localField/foreignField and bare-key cases replace a
    // plain range with no leading `$` — same reasoning, opposite prefix.
    const text = '{\n  $lookup: {\n    from: "orders",\n    localField: "en';
    const suggestions = complete(text, { entry });
    const entity = suggestions.find((s) => s.insertText === "entity");
    expect(entity).toBeDefined();
    expect(entity!.label).toBe("entity");
  });
});
