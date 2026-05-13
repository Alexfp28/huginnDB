import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { loader } from "@monaco-editor/react";

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
// back to the CDN loader race.
loader.init();
