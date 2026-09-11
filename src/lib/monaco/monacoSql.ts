/**
 * Monaco SQL language providers (autocomplete + per-statement "▶ Run"
 * CodeLens), registered ONCE per Monaco instance and served per editor.
 *
 * Monaco's `registerCompletionItemProvider` / `registerCodeLensProvider` /
 * `registerCommand` are **global to the language**, not scoped to an editor.
 * The previous code registered them inside every `QueryEditorTab`'s
 * `onMount`, so with N query tabs open you got N providers — N duplicate
 * "▶ Run" lenses on each statement and N copies of every suggestion.
 *
 * Here the providers are installed exactly once (`ensureSqlProviders`, guarded
 * on the Monaco instance) and dispatch to a per-model registry. Each editor
 * registers its model's live data on mount (`registerSqlEditor`) and removes
 * it on unmount, so a provider only ever serves the editor that owns the model
 * Monaco is asking about.
 */

import type { Monaco } from "@monaco-editor/react";
import i18n from "@/lib/i18n";

export interface SqlCompletion {
  label: string;
  kind: "table" | "column" | "keyword";
  detail?: string;
  sortText?: string;
}

export interface SqlLens {
  startLine: number;
  text: string;
}

interface EditorEntry {
  getCompletions: () => SqlCompletion[];
  getLenses: () => SqlLens[];
  runStatement: (text: string) => void;
  /**
   * Override the lens's label and tooltip. Defaults to "▶ Run" / "run this
   * statement", which is what a query tab means by it.
   *
   * A function rather than two strings so the label is resolved at render
   * time: `i18n.t` is called when the lens is provided, and an entry that
   * captured the string at registration would keep the language the editor
   * mounted in after the user switches.
   *
   * The AI panel's SQL blocks are the reason this exists. Their lens does not
   * *run* anything — it opens the statement in a query tab, where the tab's
   * own ▶ Run and every guard behind it apply (decision D4: the assistant
   * proposes, the user runs). A lens there labelled "Run" would promise
   * execution the panel deliberately does not perform.
   */
  lensLabel?: () => { title: string; tooltip: string };
}

/**
 * Per-model live data, keyed by `model.uri.toString()`.
 *
 * Shared across every language that gets the "▶ Run" lens, not just `sql`: a
 * model has exactly one owning editor, so the Mongo query editor registers
 * here too (see `ensureRunLensProvider`) and only its `getCompletions` goes
 * unread — its suggestions come from `monacoMongoQuery.ts`'s own registry,
 * because they are structural rather than a flat word list.
 */
const registry = new Map<string, EditorEntry>();

/** The Monaco instance the SQL completion provider has been installed on. */
let installed: Monaco | null = null;

/** The Monaco instance the shared lens command has been installed on. */
let commandInstalled: Monaco | null = null;

/** Languages the "▶ Run" lens provider has been installed for, per Monaco
 *  instance — the provider is global *per language* (gotcha #9), so the guard
 *  has to be keyed by language rather than by Monaco alone. */
const lensInstalled = new Map<string, Monaco>();

/** Shared CodeLens invalidation emitter — firing it refreshes every model's
 *  gutter, which is cheap and avoids one emitter per editor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lensEmitter: { fire: (e: unknown) => void; event: any } | null = null;

/** Install the shared lens emitter + `huginndb.runStatement` command once for
 *  this Monaco instance. Both are global (not per language), so every lens
 *  provider installed below routes through this one command. */
function ensureRunCommand(monaco: Monaco) {
  if (commandInstalled === monaco) return;
  commandInstalled = monaco;

  if (!lensEmitter) lensEmitter = new monaco.Emitter<unknown>();

  // Single shared command; the lens carries [modelUri, statementText] so the
  // dispatcher routes back to the owning editor's run handler.
  monaco.editor.registerCommand?.("huginndb.runStatement", (_accessor, ...args) => {
    const uri = args[0];
    const text = args[1];
    const entry = typeof uri === "string" ? registry.get(uri) : undefined;
    if (entry && typeof text === "string") entry.runStatement(text);
  });
}

/**
 * Install the per-statement "▶ Run" CodeLens provider for `languageId`.
 *
 * Split out of `ensureSqlProviders` because the query tab is not
 * SQL-only: a MongoDB connection's editor runs on its own language id
 * (`monacoMongoQuery.ts`), and a CodeLens provider registered for `"sql"`
 * simply stops being consulted there — the lens would vanish silently rather
 * than fail. The lenses themselves are language-agnostic: they come from the
 * owning editor's `getLenses`, whatever splitter produced them.
 */
export function ensureRunLensProvider(monaco: Monaco, languageId: string) {
  ensureRunCommand(monaco);
  if (lensInstalled.get(languageId) === monaco) return;
  lensInstalled.set(languageId, monaco);
  const emitter = lensEmitter!;

  monaco.languages.registerCodeLensProvider(languageId, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onDidChange: emitter.event as any,
    provideCodeLenses: (model) => {
      const entry = registry.get(model.uri.toString());
      if (!entry) return { lenses: [], dispose: () => {} };
      const uri = model.uri.toString();
      const label = entry.lensLabel?.() ?? {
        title: `▶ ${i18n.t("query.run")}`,
        tooltip: i18n.t("query.runStatement"),
      };
      return {
        lenses: entry.getLenses().map((stmt, idx) => ({
          range: {
            startLineNumber: stmt.startLine,
            startColumn: 1,
            endLineNumber: stmt.startLine,
            endColumn: 1,
          },
          id: `run-stmt-${idx}-${stmt.startLine}`,
          command: {
            id: "huginndb.runStatement",
            title: label.title,
            tooltip: label.tooltip,
            arguments: [uri, stmt.text],
          },
        })),
        dispose: () => {},
      };
    },
    resolveCodeLens: (_m, lens) => lens,
  });
}

/** Install the SQL providers once for this Monaco instance. */
export function ensureSqlProviders(monaco: Monaco) {
  ensureRunCommand(monaco);
  ensureRunLensProvider(monaco, "sql");
  if (installed === monaco) return;
  installed = monaco;

  monaco.languages.registerCompletionItemProvider("sql", {
    provideCompletionItems: (model, position) => {
      const entry = registry.get(model.uri.toString());
      if (!entry) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const kindFor = (k: SqlCompletion["kind"]) => {
        switch (k) {
          case "table":
            return monaco.languages.CompletionItemKind.Class;
          case "column":
            return monaco.languages.CompletionItemKind.Field;
          case "keyword":
            return monaco.languages.CompletionItemKind.Keyword;
        }
      };
      return {
        suggestions: entry.getCompletions().map((s) => ({
          label: s.label,
          kind: kindFor(s.kind),
          insertText: s.label,
          detail: s.detail,
          sortText: s.sortText,
          range,
        })),
      };
    },
  });
}

/** Register one editor's live data. Returns a disposer that unregisters it. */
export function registerSqlEditor(uri: string, entry: EditorEntry): () => void {
  registry.set(uri, entry);
  return () => {
    registry.delete(uri);
  };
}

/** Refresh all SQL CodeLens gutters (call after a buffer edit re-splits). */
export function fireSqlLensChange() {
  lensEmitter?.fire(undefined);
}
