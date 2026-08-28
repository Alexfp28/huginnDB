/**
 * `@monaco-editor/react`'s `<Editor>` runs `editor.updateOptions(options)` in
 * an effect keyed on `[options]`, and its content-change wiring is a second
 * effect keyed on `[isEditorReady, onChange]` that does `dispose()` +
 * `onDidChangeModelContent(...)` on every change. Both `options` and
 * `onChange` were built as fresh object/function literals inline in JSX at
 * every one of the seven Monaco call sites in this app, so every one of
 * those components re-reconfigured its Monaco instance — and tore down and
 * re-registered its content listener — on every single render, whether or
 * not any actual preference changed.
 *
 * This is a thin, named wrapper over `useMemo` rather than a new mechanism:
 * the point is that the memo lives in one place callers can copy, instead
 * of being hand-rolled seven times with seven chances to get the dependency
 * array wrong. The risk is real and specific — a dependency array that
 * doesn't cover every field the factory reads makes a preference silently
 * stop applying live, which looks like nothing (no error, just "the toggle
 * didn't do anything"). Depend on the FULL `EditorPrefs` object as returned
 * by `usePreferences(selectEditorPrefs)` (referentially stable — see that
 * selector's doc comment) rather than picking individual fields out of it,
 * plus any call-site-specific extra as a PRIMITIVE (never an inline object
 * or array literal, which would be a fresh reference every render and
 * defeat the memo the same way the original bug did).
 */
import { useMemo, type DependencyList } from "react";

export function useEditorOptions<T extends Record<string, unknown>>(
  build: () => T,
  deps: DependencyList,
): T {
  // The dependency array is caller-supplied by design (each Monaco surface
  // has a genuinely different option set — see `editorOptions.ts`'s doc
  // comment) — this hook cannot know it statically, so there is nothing for
  // a lint rule to check here even where one exists.
  return useMemo(build, deps);
}
