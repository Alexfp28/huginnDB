/**
 * Docked right-side cell editor (JetBrains-style). Renders the shared
 * `CellEditorBody` against whatever cell the user last sent here via the
 * `useCellEditor` store — from the grid's "Open in side editor" context-menu
 * item, or the "move to side panel" button in the modal editor.
 *
 * Lives in the outer dockview as the `side-editor` panel, so it inherits free
 * resize / dock / float and stays open across tab switches until the user
 * closes it. When no cell is targeted it shows a hint.
 *
 * NOTE: we never call `window.confirm`/`alert` here — Tauri's webview blocks
 * the native dialogs ("dialog.confirm not allowed"), so the unsaved-changes
 * guard uses an in-app `Dialog` instead.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CellEditorBody } from "@/components/CellEditor";
import { useCellEditor, type CellEditorTarget } from "@/stores/cellEditor";
import { detectLanguage, type ContentLanguage } from "@/lib/detectContentType";

export function SideEditorPanel() {
  const { t } = useTranslation();
  // Single-object selector — reference-stable until open/close (gotcha #1).
  const target = useCellEditor((s) => s.target);
  const close = useCellEditor((s) => s.close);

  const [value, setValue] = useState("");
  const [language, setLanguage] = useState<ContentLanguage>("plaintext");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A target the user clicked while the buffer had unsaved edits; drives the
   *  discard-confirmation dialog. */
  const [pendingTarget, setPendingTarget] = useState<CellEditorTarget | null>(
    null,
  );

  /** The target whose value is currently loaded into the buffer. Lets us
   *  detect when the store points at a *different* cell (the user clicked
   *  another one) versus a re-render of the same target. */
  const loadedTargetRef = useRef<CellEditorTarget | null>(null);
  /** Baseline to detect unsaved edits: the value as last loaded. */
  const baselineRef = useRef<string>("");
  /**
   * Live mirror of `value`. The follow-the-selection effect below depends only
   * on `target`, so the `value` it would close over is frozen at the render
   * the effect was registered (stale). Reading the buffer through this ref
   * gives the effect the *current* text, so the dirty check actually fires.
   */
  const valueRef = useRef("");
  valueRef.current = value;

  /** Load a target's value into the buffer and mark it as the loaded one. */
  function load(next: CellEditorTarget) {
    loadedTargetRef.current = next;
    baselineRef.current = next.value;
    setValue(next.value);
    setLanguage(detectLanguage(next.value ?? ""));
  }

  // Follow the selected cell. When the store points at a new target, load it —
  // but if the current buffer has unsaved edits, stash the new target and open
  // the discard-confirmation dialog instead of swapping immediately.
  useEffect(() => {
    if (!target) {
      loadedTargetRef.current = null;
      return;
    }
    if (target === loadedTargetRef.current) return;

    const dirty =
      loadedTargetRef.current !== null &&
      valueRef.current !== baselineRef.current;
    if (dirty) {
      setPendingTarget(target);
      return;
    }
    load(target);
    // `value` intentionally excluded — read live via valueRef, not as a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("cellEditor.sideEmpty")}
      </div>
    );
  }

  const readonly = target.readonly || !target.onSave;

  async function handleSave() {
    if (!target?.onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await target.onSave(value);
      // Saved value is the new baseline; close the editing session.
      baselineRef.current = value;
      close();
    } catch (e) {
      setSaveError(t("cellEditor.saveFailed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-2 px-1">
        <span className="truncate text-xs font-semibold">
          {target.columnName || t("cellEditor.title")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t("cellEditor.chars", { count: value.length })}
        </span>
      </div>
      <CellEditorBody
        value={value}
        onChange={setValue}
        language={language}
        onLanguageChange={setLanguage}
        readonly={readonly}
      />
      {saveError && (
        <div className="px-1 text-[11px] text-destructive">{saveError}</div>
      )}
      <div className="flex justify-end gap-2 px-1">
        <Button variant="outline" size="sm" onClick={close}>
          {readonly ? t("common.close") : t("cellEditor.discard")}
        </Button>
        {!readonly && (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t("cellEditor.saving") : t("common.save")}
          </Button>
        )}
      </div>

      {/* Unsaved-changes guard when switching cells. */}
      <Dialog
        open={!!pendingTarget}
        onOpenChange={(open) => {
          if (!open) {
            // Cancel: stay on the current cell. Re-pin the loaded target in the
            // store so a later click on the same new cell prompts again.
            if (loadedTargetRef.current) {
              useCellEditor.getState().open(loadedTargetRef.current);
            }
            setPendingTarget(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("cellEditor.discardChangesTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("cellEditor.discardChangesConfirm")}
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (loadedTargetRef.current) {
                  useCellEditor.getState().open(loadedTargetRef.current);
                }
                setPendingTarget(null);
              }}
            >
              {t("cellEditor.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingTarget) load(pendingTarget);
                setPendingTarget(null);
              }}
            >
              {t("cellEditor.discardAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
