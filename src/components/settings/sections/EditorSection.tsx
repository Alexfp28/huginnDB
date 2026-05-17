/**
 * Editor preferences — Monaco knobs (font, size, wrap, minimap, line
 * numbers). The Monaco editor instances pick these up via
 * `usePreferences(selectEditorPrefs)`; this section only writes them.
 */

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import { PrefRow } from "./PrefRow";

export function EditorSection() {
  const editor = usePreferences(selectEditorPrefs);
  const updateEditor = usePreferences((s) => s.updateEditor);
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
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
