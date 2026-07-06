/**
 * Cell editor — HuginnDB's star feature. A full Monaco editor with
 * auto-detected JSON / XML / SQL highlighting, format/beautify, and live JSON
 * validation. Presented either inside a dialog (`CellEditor`, the default) or
 * as a docked right-side panel (`SideEditorPanel`, JetBrains-style); both share
 * the `CellEditorBody` below so the Monaco wiring lives in one place.
 *
 * The editor is read-only when no `onSave` callback is provided; when one is
 * provided, the user's content is passed back to it as a string on save.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Editor from "@monaco-editor/react";
import { detectLanguage, tryFormat, type ContentLanguage } from "@/lib/detectContentType";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import { resolveMonacoTheme } from "@/lib/monaco-themes";
import { useCellEditor } from "@/stores/cellEditor";
import { openSideEditor } from "@/lib/dockview";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: string;
  columnName?: string;
  readonly?: boolean;
  onSave?: (value: string) => Promise<void> | void;
}

/**
 * Reusable editor body: language picker, format button, JSON badge and the
 * Monaco surface. Stateless about its presentation (dialog vs side panel) —
 * the parent owns the buffer and the layout chrome.
 */
export function CellEditorBody({
  value,
  onChange,
  language,
  onLanguageChange,
  readonly,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  language: ContentLanguage;
  onLanguageChange: (l: ContentLanguage) => void;
  readonly?: boolean;
  /** Save/commit action bound to Ctrl/Cmd+S and Ctrl/Cmd+Enter inside Monaco. */
  onSubmit?: () => void;
}) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Ctrl+S / Ctrl+Enter must be bound through Monaco's addCommand: Monaco
  // swallows them inside its focus area, so a window keydown listener never
  // sees them (CLAUDE.md gotcha #9). The command reads a ref so the handler
  // never freezes to the first render's `onSubmit`.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          value={language}
          onValueChange={(v) => onLanguageChange(v as ContentLanguage)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="plaintext">{t("cellEditor.langPlain")}</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
            <SelectItem value="xml">XML</SelectItem>
            <SelectItem value="sql">SQL</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange(tryFormat(value, language))}
        >
          {t("cellEditor.format")}
        </Button>
        {language === "json" && <JsonValidationBadge value={value} />}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
        <Editor
          height="100%"
          value={value}
          language={language}
          theme={resolveMonacoTheme(editorPrefs.theme)}
          onChange={(v) => onChange(v ?? "")}
          onMount={(editor, monacoNs) => {
            const save = () => onSubmitRef.current?.();
            editor.addCommand(monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyS, save);
            editor.addCommand(monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.Enter, save);
          }}
          options={{
            readOnly: !!readonly,
            minimap: { enabled: editorPrefs.minimap },
            wordWrap: editorPrefs.wordWrap ? "on" : "off",
            fontFamily: editorPrefs.fontFamily,
            fontSize: editorPrefs.fontSize,
            tabSize: editorPrefs.tabSize,
            lineNumbers: editorPrefs.lineNumbers ? "on" : "off",
            formatOnPaste: editorPrefs.formatOnPaste,
            scrollBeyondLastLine: false,
            folding: true,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

export function CellEditor({
  open,
  onOpenChange,
  initialValue,
  columnName,
  readonly,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const detected = useMemo(() => detectLanguage(initialValue ?? ""), [initialValue]);
  const [language, setLanguage] = useState<ContentLanguage>(detected);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const openInSide = useCellEditor((s) => s.open);
  const canSave = !readonly && !!onSave;
  // Modifier label for the save-shortcut chip (⌘ on macOS, Ctrl elsewhere).
  const saveHint = /Mac/i.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";
  // Content-type badge label: the auto-detected / selected language.
  const typeLabel = language === "plaintext" ? "TEXT" : language.toUpperCase();
  const bytes = useMemo(() => new TextEncoder().encode(value).length, [value]);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setLanguage(detectLanguage(initialValue ?? ""));
      setSaveError(null);
    }
  }, [open, initialValue]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === "F11") {
        e.preventDefault();
        setFullscreen((v) => !v);
      }
      if (e.key === "Escape" && fullscreen) {
        e.preventDefault();
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, fullscreen]);

  async function handleSave() {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(value);
      onOpenChange(false);
    } catch (e) {
      // Tauri blocks window.alert, so surface the error inline instead.
      setSaveError(t("cellEditor.saveFailed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  /** Hand the (live) buffer to the docked side panel and close the modal. */
  function moveToSidePanel() {
    openInSide({
      columnName: columnName ?? "",
      value,
      readonly,
      onSave,
    });
    openSideEditor();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-3 p-4",
          fullscreen
            ? "left-0 top-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0"
            : "h-[80vh] max-w-5xl",
        )}
      >
        <DialogHeader>
          {/* Titled header rail for the flagship editor: column name +
              content-type badge + char/byte pills, with the panel/fullscreen
              controls grouped right. `pr-8` reserves space for the dialog's
              built-in close button (replaces the old per-button `mr-8` hack). */}
          <DialogTitle className="flex items-center gap-2 pr-8">
            <span className="truncate font-mono text-sm font-semibold">
              {columnName ?? t("cellEditor.title")}
            </span>
            <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-brand">
              {typeLabel}
            </span>
            <span className="hidden shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground sm:flex">
              <span className="rounded bg-muted px-1.5 py-0.5">
                {t("cellEditor.chars", { count: value.length })}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5">
                {bytes.toLocaleString()} B
              </span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={moveToSidePanel}
                title={t("cellEditor.moveToSide")}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setFullscreen((v) => !v)}
                title={
                  fullscreen
                    ? t("cellEditor.exitFullscreen")
                    : t("cellEditor.fullscreen")
                }
              >
                {fullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <CellEditorBody
            value={value}
            onChange={setValue}
            language={language}
            onLanguageChange={setLanguage}
            readonly={readonly}
            onSubmit={canSave ? handleSave : undefined}
          />
        </div>
        {saveError && (
          <div className="text-xs text-destructive">{saveError}</div>
        )}
        <DialogFooter className="items-center">
          {canSave && (
            <span className="mr-auto flex items-center gap-1 text-2xs text-muted-foreground">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                {saveHint}
              </kbd>
              {t("common.save")}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {readonly ? t("common.close") : t("cellEditor.discard")}
          </Button>
          {canSave && (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("cellEditor.saving") : t("common.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonValidationBadge({ value }: { value: string }) {
  const { t } = useTranslation();
  if (!value.trim()) return null;
  try {
    JSON.parse(value);
    return (
      <span className="rounded bg-success/10 px-1.5 py-0.5 text-2xs font-medium text-success">
        {t("cellEditor.jsonValid")}
      </span>
    );
  } catch (e) {
    // Compact badge; the full parser message goes to the tooltip rather than
    // being dumped raw into the toolbar row.
    return (
      <span
        className="rounded bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive"
        title={(e as Error).message}
      >
        {t("cellEditor.jsonInvalidShort")}
      </span>
    );
  }
}
