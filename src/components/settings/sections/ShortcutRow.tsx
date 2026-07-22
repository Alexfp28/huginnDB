/**
 * One rebindable-shortcut row: idle state shows the current combo + a reset
 * button; clicking it enters capture mode, where the next keydown becomes
 * the new combo (Escape always cancels, never becomes the binding itself).
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { comboFromEvent, formatComboForDisplay, type ActionSpec } from "@/lib/keybindings";
import { PrefRow } from "./PrefRow";

interface Props {
  action: ActionSpec;
  combo: string;
  isDefault: boolean;
  isCapturing: boolean;
  conflictMsg: string | null;
  onStartCapture: () => void;
  onCancelCapture: () => void;
  onCaptured: (combo: string) => void;
  onReset: () => void;
}

export function ShortcutRow({
  action,
  combo,
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
      const next = comboFromEvent(e);
      if (next === null) return; // bare modifier keydown — keep listening
      onCaptured(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isCapturing, onCancelCapture, onCaptured]);

  return (
    <PrefRow
      label={t(action.labelKey)}
      description={
        isCapturing
          ? (conflictMsg ?? t("settings.shortcuts.pressKey"))
          : action.id === "refreshData"
            ? t("settings.shortcuts.refreshHint")
            : undefined
      }
    >
      <div className="flex items-center gap-1">
        {isCapturing ? (
          <Button variant="outline" size="sm" onClick={onCancelCapture}>
            {t("common.cancel")}
          </Button>
        ) : (
          <button
            type="button"
            onClick={onStartCapture}
            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-brand hover:text-foreground"
          >
            {formatComboForDisplay(combo)}
          </button>
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
