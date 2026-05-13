/**
 * Compact floating cell-value preview panel, anchored to the bottom-right
 * of the DataGrid container.
 *
 * Shows the column name, detected content type (JSON / XML / SQL / text),
 * a formatted preview of the cell value, and keyboard shortcut hints for
 * fullscreen view, saving, and closing.
 *
 * F11 / the fullscreen button escalates to the full Monaco-based CellEditor.
 * Esc closes the panel without discarding anything.
 */

import { useEffect, useMemo } from "react";
import { X, Maximize2 } from "lucide-react";
import { detectLanguage, tryFormat } from "@/lib/detectContentType";
import { cn } from "@/lib/utils";
import type { CellValue } from "@/types";

/** Maps a detected content language to the badge label shown in the header. */
const LANG_BADGE: Record<string, string> = {
  json: "JSON",
  xml: "XML",
  sql: "SQL",
  plaintext: "TEXT",
};

interface Props {
  /** Column name displayed in the panel header. */
  columnName: string;
  /** Raw cell value from the query result. */
  value: CellValue;
  /** Called when the user closes the panel (Esc or ×). */
  onClose: () => void;
  /** Called when the user requests the full Monaco editor (F11). */
  onFullscreen: () => void;
  /**
   * If provided, the panel renders a Save action (Ctrl+S / ⌘S).
   * Receives the current display text; the caller is responsible for
   * persisting it via `api.updateCell`.
   */
  onSave?: (value: string) => Promise<void>;
}

export function CellPreview({
  columnName,
  value,
  onClose,
  onFullscreen,
  onSave,
}: Props) {
  /** String representation of the raw cell value. */
  const rawText = useMemo(() => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }, [value]);

  /** Content type detected from the raw text. Recomputed only when value changes. */
  const lang = useMemo(() => detectLanguage(rawText), [rawText]);

  /** Formatted display text (pretty-printed JSON, indented XML, etc.). */
  const formatted = useMemo(() => tryFormat(rawText, lang), [rawText, lang]);

  /** Handle keyboard shortcuts: F11 → fullscreen, Esc → close, Ctrl+S → save. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        onFullscreen();
      } else if (e.key === "Escape") {
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave?.(rawText);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onFullscreen, onSave, rawText]);

  const isNull = value === null || value === undefined;

  return (
    <div
      className={cn(
        "absolute bottom-2 right-2 z-20 flex w-80 flex-col",
        "rounded-lg border border-border bg-card shadow-xl",
        "overflow-hidden",
      )}
    >
      {/* Header: column name + content-type badge + close button */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">cell</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-medium">{columnName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {LANG_BADGE[lang] ?? "TEXT"}
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground/60 hover:text-muted-foreground"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content: formatted value */}
      <div className="max-h-48 overflow-auto p-3">
        {isNull ? (
          <span className="font-mono text-xs italic text-muted-foreground">
            NULL
          </span>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {formatted}
          </pre>
        )}
      </div>

      {/* Footer: keyboard shortcut hints */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/70">
        <button
          className="flex items-center gap-1 hover:text-muted-foreground"
          onClick={onFullscreen}
          title="Open in full editor"
        >
          <Maximize2 className="h-3 w-3" />
          <span>F11 fullscreen</span>
        </button>
        {onSave && (
          <button
            className="hover:text-muted-foreground"
            onClick={() => onSave(rawText)}
            title="Save cell value"
          >
            ⌘ S save
          </button>
        )}
        <button
          className="ml-auto hover:text-muted-foreground"
          onClick={onClose}
        >
          esc close
        </button>
      </div>
    </div>
  );
}
