/**
 * Editor preferences — Monaco knobs (font, size, wrap, minimap, line
 * numbers). The Monaco editor instances pick these up via
 * `usePreferences(selectEditorPrefs)`; this section only writes them.
 */

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import {
  MONACO_THEME_OPTIONS,
  getMonacoPreviewColors,
} from "@/lib/monaco-themes";
import type { EditorPrefs } from "@/types";
import { PrefRow } from "./PrefRow";

export function EditorSection() {
  const editor = usePreferences(selectEditorPrefs);
  const updateEditor = usePreferences((s) => s.updateEditor);
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
      {/* Live-ish preview: a static SQL sample rendered with the chosen font,
          size, wrap and theme colours (no real Monaco — cheaper, no workers). */}
      <EditorPreview editor={editor} />

      {/* Theme picker — One Dark Pro, GitHub, Monokai, Solarized, plus
          the two Monaco built-ins. Defined in `lib/monaco-themes.ts`
          and registered at app boot from `monaco-setup.ts`. */}
      <PrefRow
        label={t("settings.editor.theme")}
        htmlFor="prefs-editor-theme"
      >
        <Select
          value={editor.theme}
          onValueChange={(v) => updateEditor({ theme: v })}
        >
          <SelectTrigger id="prefs-editor-theme" className="h-8 w-56 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONACO_THEME_OPTIONS.map((opt) => (
              <SelectItem key={opt.id} value={opt.id} className="text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.editor.fontFamily")}
        htmlFor="prefs-editor-font-family"
      >
        <Input
          id="prefs-editor-font-family"
          value={editor.fontFamily}
          onChange={(e) => updateEditor({ fontFamily: e.target.value })}
          className="h-8 w-56 font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.editor.fontSize")}
        htmlFor="prefs-editor-font-size"
      >
        <Input
          id="prefs-editor-font-size"
          type="number"
          min={9}
          max={32}
          value={editor.fontSize}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) updateEditor({ fontSize: n });
          }}
          className="h-8 w-20 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.editor.tabSize")}
        htmlFor="prefs-editor-tab-size"
      >
        <Input
          id="prefs-editor-tab-size"
          type="number"
          min={1}
          max={8}
          value={editor.tabSize}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) updateEditor({ tabSize: n });
          }}
          className="h-8 w-20 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.editor.wordWrap.label")}
        description={t("settings.editor.wordWrap.desc")}
      >
        <Switch
          checked={editor.wordWrap}
          onCheckedChange={(v) => updateEditor({ wordWrap: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.editor.minimap.label")}
        description={t("settings.editor.minimap.desc")}
      >
        <Switch
          checked={editor.minimap}
          onCheckedChange={(v) => updateEditor({ minimap: v })}
        />
      </PrefRow>

      <PrefRow label={t("settings.editor.lineNumbers")}>
        <Switch
          checked={editor.lineNumbers}
          onCheckedChange={(v) => updateEditor({ lineNumbers: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.editor.formatOnPaste.label")}
        description={t("settings.editor.formatOnPaste.desc")}
      >
        <Switch
          checked={editor.formatOnPaste}
          onCheckedChange={(v) => updateEditor({ formatOnPaste: v })}
        />
      </PrefRow>
    </div>
  );
}

/** Sample SQL line: literal text + the token class that colours it. */
type Tok = { text: string; kind?: "keyword" | "string" | "number" | "comment" };
const SAMPLE: Tok[][] = [
  [{ text: "-- recent active users", kind: "comment" }],
  [
    { text: "SELECT", kind: "keyword" },
    { text: " id, name, created_at" },
  ],
  [
    { text: "FROM", kind: "keyword" },
    { text: " users" },
  ],
  [
    { text: "WHERE", kind: "keyword" },
    { text: " status = " },
    { text: "'active'", kind: "string" },
    { text: " AND age > " },
    { text: "18", kind: "number" },
  ],
  [
    { text: "ORDER BY", kind: "keyword" },
    { text: " created_at " },
    { text: "DESC", kind: "keyword" },
    { text: ";" },
  ],
];

/**
 * Static preview of the editor: renders {@link SAMPLE} with the user's font,
 * size, wrap and the selected Monaco theme's colours. Not a real editor (no
 * Monaco instance / workers) — it just reflects the knobs at a glance.
 */
function EditorPreview({ editor }: { editor: EditorPrefs }) {
  const { t } = useTranslation();
  const c = getMonacoPreviewColors(editor.theme);
  const colorFor = (kind?: Tok["kind"]) =>
    kind ? c[kind] : c.foreground;
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("settings.editor.preview")}
      </div>
      <div
        className="flex overflow-hidden rounded-md border border-border"
        style={{ background: c.background }}
      >
        <div className="flex min-w-0 flex-1">
          {editor.lineNumbers && (
            <div
              className="select-none px-2 py-2 text-right"
              style={{
                color: c.lineNumber,
                fontFamily: editor.fontFamily,
                fontSize: editor.fontSize,
                lineHeight: 1.5,
              }}
            >
              {SAMPLE.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
          )}
          <pre
            className={`flex-1 py-2 pr-3 ${editor.lineNumbers ? "pl-1" : "pl-3"} ${
              editor.wordWrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
            }`}
            style={{
              color: c.foreground,
              fontFamily: editor.fontFamily,
              fontSize: editor.fontSize,
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {SAMPLE.map((line, i) => (
              <div key={i}>
                {line.map((tok, j) => (
                  <span key={j} style={{ color: colorFor(tok.kind) }}>
                    {tok.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
        </div>
        {editor.minimap && (
          // A faint sliver standing in for the minimap, just so the toggle has
          // a visible effect in the preview.
          <div
            className="w-8 shrink-0 opacity-40"
            style={{
              background: `linear-gradient(${c.foreground} 1px, transparent 1px)`,
              backgroundSize: "100% 3px",
            }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
