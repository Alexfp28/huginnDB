/**
 * Reactive companion to `resolveMonacoTheme`.
 *
 * The curated catalogue is a compile-time constant, but an imported VS Code
 * theme's definition is not: it lives in `installed_themes.json` and reaches
 * the frontend through `hydrateInstalledThemes`, one async call after first
 * paint. `resolveMonacoTheme` refuses an id nothing has defined yet — it has
 * to, since `monaco.editor.setTheme` throws on an unknown id — so an editor
 * that mounts inside that window resolves the user's imported theme down to
 * `huginn-dark`.
 *
 * Nothing then brought it back: `<Editor theme={...}>` only re-applies when
 * the prop changes, and the prop was computed from a module-level `Map` no
 * component subscribes to. The result was the bug this hook exists to close —
 * every editor in the app stuck on the default theme for the whole session,
 * while the app chrome showed the imported palette correctly.
 *
 * Subscribing to the theme store's `importedEditorThemes` is what makes the
 * id derived rather than sampled: the same state update that registers the
 * definitions re-renders every editor, and they land on the real theme.
 */

import { useMemo } from "react";
import { useThemeStore } from "@/stores/preferences/theme";
import { resolveMonacoTheme, type MonacoThemeId } from "./monaco-themes";

export function useMonacoTheme(id: string | undefined): MonacoThemeId {
  const imported = useThemeStore((s) => s.importedEditorThemes);
  // `imported` is not read inside — it is the subscription. Listing it as a
  // dependency is the point: a new map identity means a definition landed (or
  // was deleted), which is exactly when a resolve can change its answer.
  return useMemo(() => resolveMonacoTheme(id), [id, imported]);
}
