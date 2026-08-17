/**
 * The Monaco editor used by both aggregation modes — one stage's body in the
 * stage editor, the whole array literal in the text editor.
 *
 * It exists as its own component because the wiring around a Monaco instance in
 * this app is never just "render an editor": the language has to be registered
 * on the instance (`ensureMongoLanguage`), `Ctrl+Enter` has to be bound through
 * Monaco's own command system because a `window` listener never sees it inside
 * the editor's focus area (gotcha #9), and the user-rebindable global shortcuts
 * have to be re-dispatched out of it (`registerEditorActionRedispatch`) for the
 * same reason. Getting that wrong in N stage cards would be N times as wrong.
 */

import { useEffect, useRef } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import {
  ensureMongoLanguage,
  MONGO_PIPELINE_LANGUAGE,
} from "@/lib/monaco/monacoMongo";
import { registerEditorActionRedispatch } from "@/lib/monaco/monacoKeybindings";
import { resolveMonacoTheme } from "@/lib/monaco/monaco-themes";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences/preferences";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter — force an immediate preview, bypassing the debounce. */
  onRun?: () => void;
  height: string | number;
  readOnly?: boolean;
  /** Line numbers are noise on a six-line stage body and useful on a
   *  200-line pipeline, so the caller decides. */
  lineNumbers?: boolean;
}

export function PipelineEditor({
  value,
  onChange,
  onRun,
  height,
  readOnly,
  lineNumbers = false,
}: Props) {
  const editorPrefs = usePreferences(selectEditorPrefs);

  // `addCommand` keeps its handler for the editor's lifetime, so it reads the
  // latest callback through a ref rather than closing over the first render's
  // (the same reason `QueryEditorTab` has `runQueryRef`).
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  const shortcutsDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      shortcutsDisposeRef.current?.();
      shortcutsDisposeRef.current = null;
    };
  }, []);

  function handleMount(rawEditor: unknown, monaco: Monaco) {
    const editor = rawEditor as {
      addCommand: (keybinding: number, handler: () => void) => string | null;
      onKeyDown: (
        fn: (e: { browserEvent: KeyboardEvent }) => void,
      ) => { dispose: () => void };
    };
    ensureMongoLanguage(monaco);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current?.();
    });
    shortcutsDisposeRef.current?.();
    shortcutsDisposeRef.current = registerEditorActionRedispatch(editor, [
      {
        id: "toggleCommandPalette",
        run: () => useCommandPalette.getState().toggle(),
      },
      {
        id: "openCommandActions",
        run: () => useCommandPalette.getState().openWith(">"),
      },
      { id: "toggleTabSwitcher", run: () => useTabSwitcher.getState().toggle() },
    ]);
  }

  return (
    <Editor
      height={height}
      language={MONGO_PIPELINE_LANGUAGE}
      theme={resolveMonacoTheme(editorPrefs.theme)}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        wordWrap: editorPrefs.wordWrap ? "on" : "off",
        fontFamily: editorPrefs.fontFamily,
        fontSize: editorPrefs.fontSize,
        tabSize: 2,
        lineNumbers: lineNumbers ? "on" : "off",
        lineDecorationsWidth: lineNumbers ? undefined : 8,
        lineNumbersMinChars: lineNumbers ? 3 : 0,
        folding: true,
        glyphMargin: false,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
        scrollbar: { alwaysConsumeMouseWheel: false },
      }}
    />
  );
}
