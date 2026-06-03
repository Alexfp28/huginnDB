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
}

/** Per-model live data, keyed by `model.uri.toString()`. */
const registry = new Map<string, EditorEntry>();

/** The Monaco instance the providers have been installed on (idempotency). */
let installed: Monaco | null = null;

/** Shared CodeLens invalidation emitter — firing it refreshes every model's
 *  gutter, which is cheap and avoids one emitter per editor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lensEmitter: { fire: (e: unknown) => void; event: any } | null = null;

/** Install the SQL providers once for this Monaco instance. */
export function ensureSqlProviders(monaco: Monaco) {
  if (installed === monaco) return;
  installed = monaco;

  if (!lensEmitter) lensEmitter = new monaco.Emitter<unknown>();
  const emitter = lensEmitter;

  // Single shared command; the lens carries [modelUri, statementText] so the
  // dispatcher routes back to the owning editor's run handler.
  monaco.editor.registerCommand?.("huginndb.runStatement", (_accessor, ...args) => {
    const uri = args[0];
    const text = args[1];
    const entry = typeof uri === "string" ? registry.get(uri) : undefined;
    if (entry && typeof text === "string") entry.runStatement(text);
  });

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

  monaco.languages.registerCodeLensProvider("sql", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onDidChange: emitter.event as any,
    provideCodeLenses: (model) => {
      const entry = registry.get(model.uri.toString());
      if (!entry) return { lenses: [], dispose: () => {} };
      const uri = model.uri.toString();
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
            title: `▶ ${i18n.t("query.run")}`,
            tooltip: i18n.t("query.runStatement"),
            arguments: [uri, stmt.text],
          },
        })),
        dispose: () => {},
      };
    },
    resolveCodeLens: (_m, lens) => lens,
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
