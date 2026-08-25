/**
 * Records one binding for one action.
 *
 * The load-bearing detail is that capture is **armed, not permanent**. While
 * armed, a capture-phase window listener eats every keystroke — which is what
 * lets you record `Escape` or `Enter` as a binding. The moment a chord lands,
 * capture disarms and those two keys go back to meaning Cancel and Save, so
 * the whole dialog stays operable from the keyboard. "Add a second chord"
 * re-arms it, which is how a sequence like `Mod+K Mod+S` gets recorded without
 * a modal-inside-a-modal or a timeout the user has to race.
 *
 * Conflicts are shown as you record rather than on submit: `findConflicts`
 * only reports bindings whose scope can actually be heard alongside this one,
 * so anything it returns is a real ambiguity and the dialog offers to take the
 * key off the other action rather than just refusing.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  ACTION_BY_ID,
  chordFromEvent,
  findConflicts,
  formatForDisplay,
  type ActionId,
  type ActionSpec,
  type Binding,
  type Keybindings,
} from "@/lib/keybindings";

interface Props {
  action: ActionSpec | null;
  keybindings: Keybindings;
  /** The binding being replaced, or `null` when adding a new one. */
  replacing: string | null;
  onCancel: () => void;
  /** `clearFrom` lists actions the caller must strip this binding from. */
  onSave: (binding: string, clearFrom: ActionId[]) => void;
}

export function CaptureShortcutDialog({
  action,
  keybindings,
  replacing,
  onCancel,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const [chords, setChords] = useState<string[]>([]);
  const [armed, setArmed] = useState(true);
  // Whether the next recorded chord extends the sequence or replaces it. A ref
  // rather than state because the listener below reads it at fire time and
  // must not be re-registered when it changes.
  const appending = useRef(false);

  // Re-arm and clear whenever a different row opens the dialog.
  useEffect(() => {
    if (!action) return;
    setChords(replacing ? replacing.split(" ") : []);
    appending.current = false;
    setArmed(true);
  }, [action, replacing]);

  useEffect(() => {
    if (!action || !armed) return;
    const onKey = (e: KeyboardEvent) => {
      // Everything is swallowed while armed — including Escape, which is a
      // perfectly reasonable thing to want to bind.
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing) return;
      const chord = chordFromEvent(e);
      if (chord === null) return; // bare modifier — keep listening
      setChords((prev) => (appending.current ? [...prev, chord] : [chord]));
      appending.current = false;
      setArmed(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [action, armed]);

  if (!action) return null;

  const binding = chords.join(" ");
  const clashes: Binding[] = binding
    ? findConflicts(keybindings, action.id, binding)
    : [];
  const reserved = clashes.length > 0 && clashes.every((c) => c.fixed);
  const canSave = binding.length > 0 && !reserved;

  function label(id: ActionId): string {
    const spec = ACTION_BY_ID.get(id);
    return spec ? t(spec.labelKey) : id;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-w-md"
        // While armed the window listener already swallowed the keystroke; this
        // stops Radix from also acting on Escape and closing the dialog.
        onEscapeKeyDown={(e) => armed && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t(action.labelKey)}</DialogTitle>
          <DialogDescription>
            {armed
              ? t("settings.shortcuts.pressKey")
              : t("settings.shortcuts.captureHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[3.5rem] flex-wrap items-center justify-center gap-1.5 rounded-md border border-border bg-muted/40 p-3">
          {chords.length === 0 ? (
            <span className="animate-pulse text-xs text-muted-foreground">
              {t("settings.shortcuts.listening")}
            </span>
          ) : (
            chords.map((chord, i) => (
              <span key={`${chord}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="text-2xs text-muted-foreground">
                    {t("settings.shortcuts.then")}
                  </span>
                )}
                <Kbd className="px-1.5 py-1 text-xs">{formatForDisplay(chord)}</Kbd>
              </span>
            ))
          )}
          {armed && chords.length > 0 && (
            <span className="text-xs text-muted-foreground">…</span>
          )}
        </div>

        {clashes.length > 0 && (
          <p className="text-xs text-warning">
            {reserved
              ? t("settings.shortcuts.reserved", { action: label(clashes[0].actionId) })
              : t("settings.shortcuts.conflict", { action: label(clashes[0].actionId) })}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={armed}
              onClick={() => {
                appending.current = false;
                setArmed(true);
              }}
            >
              {t("settings.shortcuts.recordAgain")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={armed || chords.length === 0}
              onClick={() => {
                appending.current = true;
                setArmed(true);
              }}
            >
              {t("settings.shortcuts.addChord")}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() =>
                onSave(
                  binding,
                  clashes.filter((c) => !c.fixed).map((c) => c.actionId),
                )
              }
            >
              {clashes.length > 0 && !reserved
                ? t("settings.shortcuts.reassign")
                : t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
