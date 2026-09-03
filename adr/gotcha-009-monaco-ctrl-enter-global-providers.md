# Gotcha #009: Monaco commands are per-editor; providers are global to the language

**Fecha:** 2026-09-03

Ctrl+Enter must be bound via `editor.addCommand` inside `handleMount` through a ref (a `window` keydown listener never sees it), while the completion and CodeLens providers must be registered exactly once per Monaco instance via a per-model registry, not once per editor tab, or they duplicate N times with N open tabs.

## Detail

**Monaco swallows `Ctrl+Enter` and friends inside its focus area; a `window` keydown listener never sees them.** That's why `QueryEditorTab` binds Ctrl+Enter via `editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, …)` inside `handleMount`, not via `window.addEventListener`. Because `addCommand` keeps its handler closure for the lifetime of the editor, the handler reads `runQueryRef.current()` rather than capturing `runQuery` directly — otherwise it would freeze to the first render's `sql` and `running` values. Same ref pattern applies to the completion provider and the CodeLens provider. **Crucially, those two providers — plus `registerCommand` — are GLOBAL to the language, not per-editor: registering them inside `handleMount` once per query tab caused N duplicate "▶ Run" lenses (and N× autocomplete entries) with N tabs open.** They now live in `src/lib/monaco/monacoSql.ts`, installed exactly once per Monaco instance (`ensureSqlProviders`, guarded on the instance) and dispatched per model via a registry each editor populates on mount (`registerSqlEditor`) and clears on unmount. `editor.addCommand` (Ctrl+Enter, Ctrl+K) IS per-editor and stays in `handleMount`.
