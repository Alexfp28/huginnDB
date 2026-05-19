/**
 * Cell editor — HuginnDB's star feature. A full Monaco editor presented
 * inside a dialog (or fullscreen via `F11`) with auto-detected JSON /
 * XML / SQL highlighting, format/beautify, and live JSON validation.
 *
 * The editor is read-only when no `onSave` callback is provided; when
 * one is provided, the user's content is passed back to it as a string
 * on save.
 */

import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
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
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: string;
  columnName?: string;
  readonly?: boolean;
  onSave?: (value: string) => Promise<void> | void;
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
  const theme = useThemeStore(selectActiveTheme);
  const [value, setValue] = useState(initialValue);
  const detected = useMemo(() => detectLanguage(initialValue ?? ""), [initialValue]);
  const [language, setLanguage] = useState<ContentLanguage>(detected);
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setLanguage(detectLanguage(initialValue ?? ""));
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

  function handleFormat() {
    setValue((v) => tryFormat(v, language));
  }

  async function handleSave() {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(value);
      onOpenChange(false);
    } catch (e) {
      alert(t("cellEditor.saveFailed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
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
          <DialogTitle className="flex items-center gap-3">
            <span>{columnName ?? t("cellEditor.title")}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {t("cellEditor.chars", { count: value.length })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto mr-8"
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
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Select value={language} onValueChange={(v) => setLanguage(v as ContentLanguage)}>
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
          <Button size="sm" variant="outline" onClick={handleFormat}>
            {t("cellEditor.format")}
          </Button>
          {language === "json" && (
            <JsonValidationBadge value={value} />
          )}
        </div>
        <div className="flex-1 overflow-hidden rounded-md border border-border">
          <Editor
            height="100%"
            value={value}
            language={language}
            theme={theme.mode === "dark" ? "vs-dark" : "vs-light"}
            onChange={(v) => setValue(v ?? "")}
            options={{
              readOnly: !!readonly,
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              scrollBeyondLastLine: false,
              folding: true,
              automaticLayout: true,
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {readonly ? t("common.close") : t("cellEditor.discard")}
          </Button>
          {!readonly && onSave && (
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
    return <span className="text-xs text-emerald-400">{t("cellEditor.jsonValid")}</span>;
  } catch (e) {
    return (
      <span className="text-xs text-destructive">
        {t("cellEditor.jsonInvalid", { message: (e as Error).message })}
      </span>
    );
  }
}
