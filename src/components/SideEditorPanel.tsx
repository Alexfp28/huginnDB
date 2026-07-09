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
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  /** Bumped on every cell load so Monaco remounts with a fresh, empty undo
   *  stack — otherwise Ctrl+Z would reach back into the previous cell's value
   *  since this panel reuses one editor across selections. */
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  /** When true the panel content escapes the dock and covers the whole window.
   *  The panel is a dockview pane (it can't grow past its group), so fullscreen
   *  is a fixed overlay rather than a dock resize — mirrors the modal editor's
   *  F11 toggle so the affordance is consistent. */
  const [fullscreen, setFullscreen] = useState(false);
  /** Re-entrancy guard for the Ctrl+S handler — `setSaving` is async so we
   *  can't rely on the `saving` state inside the keydown listener. */
  const savingRef = useRef(false);
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
    // New cell/session → force a fresh Monaco model (see `editorKey`).
    setEditorKey((k) => k + 1);
  }

  // Ctrl/Cmd+S saves the buffer *in place*: persist the edits, reset the
  // dirty baseline, and keep the panel open so the user can move to another
  // cell without the discard guard firing. Registered in the capture phase
  // with `stopImmediatePropagation` so it wins over the floating CellPreview's
  // own window-level Ctrl+S — which otherwise persists its stale, pre-edit
  // value and leaves this panel dirty. Bails (letting other handlers run) when
  // no editable cell is loaded here.
  useEffect(() => {
    async function onKey(e: KeyboardEvent) {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) return;
      const tgt = loadedTargetRef.current;
      if (!tgt || tgt.readonly || !tgt.onSave) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const v = valueRef.current;
        await tgt.onSave(v);
        baselineRef.current = v;
      } catch (err) {
        setSaveError(t("cellEditor.saveFailed", { message: String(err) }));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [t]);

  // F11 toggles fullscreen; Esc leaves it. Only active while a cell is loaded
  // (no target → the panel shows the empty hint and there's nothing to expand).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!loadedTargetRef.current) return;
      if (e.key === "F11") {
        e.preventDefault();
        setFullscreen((v) => !v);
      } else if (e.key === "Escape" && fullscreen) {
        e.preventDefault();
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

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
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-2 p-2",
        fullscreen && "fixed inset-0 z-50 bg-background",
      )}
    >
      <div className="flex items-center gap-2 px-1">
        <span className="truncate text-xs font-semibold">
          {target.columnName || t("cellEditor.title")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t("cellEditor.chars", { count: value.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          onClick={() => setFullscreen((v) => !v)}
          title={
            fullscreen
              ? t("cellEditor.exitFullscreen")
              : t("cellEditor.fullscreen")
          }
        >
          {fullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <CellEditorBody
        value={value}
        onChange={setValue}
        language={language}
        onLanguageChange={setLanguage}
        readonly={readonly}
        editorKey={editorKey}
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
