/**
 * One rebindable-shortcut row: idle state shows every binding that fires the
 * action + a reset button; clicking a binding enters capture mode, where the
 * next keydown becomes the new one (Escape always cancels, never becomes the
 * binding itself).
 *
 * `fixed` bindings (today only `Mod+R`, which has to keep the WebView from
 * reloading the app) render dimmed and are not clickable — they are shown
 * rather than hidden, because a shortcut the user cannot discover is a
 * shortcut they will report as a bug.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chordFromEvent, formatForDisplay, type ActionSpec } from "@/lib/keybindings";
import { PrefRow } from "./PrefRow";

interface Props {
  action: ActionSpec;
  /** User-editable bindings, primary first. May be empty (unbound). */
  bindings: string[];
  isDefault: boolean;
  isCapturing: boolean;
  conflictMsg: string | null;
  onStartCapture: () => void;
  onCancelCapture: () => void;
  onCaptured: (binding: string) => void;
  onReset: () => void;
}

export function ShortcutRow({
  action,
  bindings,
  isDefault,
  isCapturing,
  conflictMsg,
  onStartCapture,
  onCancelCapture,
  onCaptured,
  onReset,
}: Props) {
  const { t } = useTranslation();

  // Capture the next keydown anywhere in the dialog while this row is
  // recording. Capture phase so it fires ahead of anything else that might
  // stop propagation; Escape always cancels rather than becoming the combo.
  useEffect(() => {
    if (!isCapturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        onCancelCapture();
        return;
      }
      const next = chordFromEvent(e);
      if (next === null) return; // bare modifier keydown — keep listening
      onCaptured(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isCapturing, onCancelCapture, onCaptured]);

  return (
    <PrefRow
      label={t(action.labelKey)}
      // Anchor for the command palette's "Shortcut: …" entries — mirrors the
      // `keybinding.<id>` prefIds its settings registry emits for `ACTIONS`.
      prefId={`keybinding.${action.id}`}
      description={
        isCapturing
          ? (conflictMsg ?? t("settings.shortcuts.pressKey"))
          : action.descKey
            ? t(action.descKey)
            : undefined
      }
    >
      <div className="flex items-center gap-1">
        {isCapturing ? (
          <Button variant="outline" size="sm" onClick={onCancelCapture}>
            {t("common.cancel")}
          </Button>
        ) : (
          <>
            {bindings.length === 0 ? (
              <button
                type="button"
                onClick={onStartCapture}
                className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-brand hover:text-foreground"
              >
                {t("settings.shortcuts.unassigned")}
              </button>
            ) : (
              bindings.map((binding) => (
                <button
                  key={binding}
                  type="button"
                  onClick={onStartCapture}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-brand hover:text-foreground"
                >
                  {formatForDisplay(binding)}
                </button>
              ))
            )}
            {action.fixed?.map((binding) => (
              <span
                key={binding}
                title={t("settings.shortcuts.fixedHint")}
                className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground/60"
              >
                {formatForDisplay(binding)}
              </span>
            ))}
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          disabled={isDefault}
          title={t("settings.shortcuts.resetToDefault")}
          onClick={onReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </PrefRow>
  );
}
