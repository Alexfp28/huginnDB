import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { loader } from "@monaco-editor/react";
import { registerMonacoThemes } from "@/lib/monaco-themes";

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
});

// Register against the directly-imported `monaco` too. `@monaco-editor/react`
// resolves the same module instance via the loader, so this is normally
// redundant — but doing it here guarantees the themes exist even if some
// code path touches the imported `monaco` namespace before `loader.init()`
// has resolved.
registerMonacoThemes(monaco);
