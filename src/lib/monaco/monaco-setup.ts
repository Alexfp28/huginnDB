import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { loader } from "@monaco-editor/react";
import { registerMonacoThemes } from "@/lib/monaco/monaco-themes";
import { ensureJsonSchemas } from "@/lib/monaco/monacoJson";

// Self-host Monaco so the app works offline and inside Tauri without any
// CDN dependency. Workers are bundled by Vite via the ?worker imports.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
// Eagerly initialize so the first time the editor mounts it doesn't fall
// back to the CDN loader race. We also register the custom theme
// catalogue (One Dark Pro, GitHub, Monokai, Solarized — see
// `monaco-themes.ts`) here so the very first editor that renders
// already finds the theme ids defined.
loader.init().then((m) => {
  registerMonacoThemes(m);
  ensureJsonSchemas(m);
});

// Register against the directly-imported `monaco` too. `@monaco-editor/react`
// resolves the same module instance via the loader, so this is normally
// redundant — but doing it here guarantees the themes exist even if some
// code path touches the imported `monaco` namespace before `loader.init()`
// has resolved.
registerMonacoThemes(monaco);
// Same reasoning for the JSON schema configuration — and it is armed here
// rather than in an editor's `onMount` on purpose: unlike the SQL and Mongo
// `ensure*` helpers, which register *providers* that may arrive late, this is
// configuration the diagnostics adapter needs before a model exists (it
// validates on `onDidCreateModel`). Arming it at setup time avoids a flash of
// unschema-ed markers on the first cell opened.
ensureJsonSchemas(monaco);
