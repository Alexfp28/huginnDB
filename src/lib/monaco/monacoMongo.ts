/**
 * A Monaco language for MongoDB aggregation source, registered ONCE per Monaco
 * instance (same rationale as `monacoSql.ts`: language providers are global,
 * not per editor — gotcha #9).
 *
 * Why not reuse an existing language? `json` runs a validator that would mark
 * every legal thing this grammar allows — unquoted keys, single quotes,
 * `ObjectId("…")`, comments — as an error, and `javascript` needs the
 * TypeScript worker we deliberately don't bundle. So the aggregation editors
 * get their own small Monarch grammar, which also lets the two things that
 * actually carry meaning in a pipeline be coloured apart:
 *
 * - an **operator key** (`$match`, `$sum`) reads as a keyword, and
 * - a **field reference** (`"$customerId"`, `"$$NOW"`) reads as a predefined
 *   name — distinct from a plain string, because mistaking one for the other
 *   is the classic pipeline bug.
 *
 * Token names are the ones every theme in `monaco-themes.ts` already styles
 * (`keyword`, `string`, `number`, `type`, `identifier`, `predefined`,
 * `delimiter`, `comment`), so a custom theme colours pipelines correctly
 * without knowing this language exists.
 */

import type { Monaco } from "@monaco-editor/react";
import { STAGE_CATALOG } from "@/lib/mongo/stages";

export const MONGO_PIPELINE_LANGUAGE = "mongodb-pipeline";

/** Expression operators offered after `$` inside a stage body. Not exhaustive
 *  by design — the common ones, so the list stays scannable. */
const EXPRESSION_OPERATORS = [
  "$abs", "$add", "$addToSet", "$and", "$arrayElemAt", "$avg", "$ceil",
  "$concat", "$concatArrays", "$cond", "$dateAdd", "$dateDiff",
  "$dateFromString", "$dateToString", "$dateTrunc", "$dayOfMonth", "$divide",
  "$eq", "$exists", "$expr", "$filter", "$first", "$floor", "$gt", "$gte",
  "$ifNull", "$in", "$inc", "$isArray", "$last", "$let", "$literal", "$lt",
  "$lte", "$map", "$max", "$mergeObjects", "$min", "$month", "$multiply",
  "$ne", "$nin", "$not", "$or", "$push", "$reduce", "$regex", "$regexMatch",
  "$round", "$size", "$slice", "$split", "$strLenCP", "$subtract", "$sum",
  "$switch", "$toDate", "$toDouble", "$toInt", "$toLong", "$toObjectId",
  "$toString", "$toUpper", "$toLower", "$trim", "$type", "$year",
];

/** BSON constructors the Rust parser accepts — kept in sync with
 *  `parse_keyword_or_ctor` in `db/mongo/shell.rs`. */
const CONSTRUCTORS = [
  "ObjectId",
  "ISODate",
  "Date",
  "NumberLong",
  "NumberInt",
  "NumberDecimal",
  "NumberDouble",
];

let installed: Monaco | null = null;

/** Register the language, its grammar and its completions. Idempotent. */
export function ensureMongoLanguage(monaco: Monaco) {
  if (installed === monaco) return;
  installed = monaco;

  monaco.languages.register({ id: MONGO_PIPELINE_LANGUAGE });

  monaco.languages.setLanguageConfiguration(MONGO_PIPELINE_LANGUAGE, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(MONGO_PIPELINE_LANGUAGE, {
    defaultToken: "",
    constructors: CONSTRUCTORS,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],

        // A constructor call — the only "function" shape in the grammar.
        [
          /[A-Za-z_][\w$]*(?=\s*\()/,
          { cases: { "@constructors": "type", "@default": "identifier" } },
        ],

        // Keys. An operator key is a keyword; anything else is a field name.
        // Both forms (bare and quoted) are checked before the value rules, so
        // the trailing `:` decides key-vs-value rather than the quoting.
        [/\$[A-Za-z_][\w$]*(?=\s*:)/, "keyword"],
        [/"\$[^"\\]*"(?=\s*:)/, "keyword"],
        [/'\$[^'\\]*'(?=\s*:)/, "keyword"],
        [/[A-Za-z_][\w$]*(?=\s*:)/, "identifier"],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "identifier"],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, "identifier"],

        // Values. A string that starts with `$` is a field path or a system
        // variable (`$$NOW`), not text — the distinction this grammar exists
        // for.
        [/"\$\$?(?:[^"\\]|\\.)*"/, "predefined"],
        [/'\$\$?(?:[^'\\]|\\.)*'/, "predefined"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],

        [/\b(?:true|false|null|undefined)\b/, "keyword"],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],

        [/[{}[\]()]/, "delimiter"],
        [/[,:]/, "delimiter"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(MONGO_PIPELINE_LANGUAGE, {
    // `$` opens the list without waiting for a word character, which is how a
    // pipeline is actually typed.
    triggerCharacters: ["$"],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: 1,
        endColumn: position.column,
      });
      // Monaco's word boundary stops at `$`, so a suggestion inserted at
      // `word.startColumn` would leave the `$` the user already typed in front
      // of it. Extend the replaced range back over it when it's there.
      const hasDollar = line.endsWith(`$${word.word}`);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn - (hasDollar ? 1 : 0),
        endColumn: word.endColumn,
      };

      const stageSuggestions = STAGE_CATALOG.map((stage, i) => ({
        label: stage.operator,
        kind: monaco.languages.CompletionItemKind.Snippet,
        // The catalogue snippet is the whole stage document; inside a body the
        // user wants just the operator, so only the operator is inserted and
        // the snippet is shown as documentation.
        insertText: `${stage.operator}: `,
        detail: "stage",
        documentation: { value: "```js\n" + stage.snippet + "\n```" },
        sortText: `0${String(i).padStart(3, "0")}`,
        range,
      }));

      const expressionSuggestions = EXPRESSION_OPERATORS.map((op) => ({
        label: op,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `${op}: `,
        detail: "expression",
        sortText: `1${op}`,
        range,
      }));

      const constructorSuggestions = CONSTRUCTORS.map((name) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Constructor,
        insertText: `${name}("$1")`,
        insertTextRules:
          monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: "BSON",
        sortText: `2${name}`,
        range,
      }));

      return {
        suggestions: [
          ...stageSuggestions,
          ...expressionSuggestions,
          ...constructorSuggestions,
        ],
      };
    },
  });
}
