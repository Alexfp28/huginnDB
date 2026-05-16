/**
 * Read-only listing of the keyboard shortcuts the app already binds.
 * Customisation is intentionally deferred — flagged here so users know it
 * is on the roadmap, not missing by oversight.
 */

import { useTranslation } from "react-i18next";

/** Combo strings stay locale-independent (key labels are universal). */
const SHORTCUTS: { combo: string; i18nKey: string }[] = [
  { combo: "Ctrl/Cmd + ,", i18nKey: "settings.shortcuts.openSettings" },
  { combo: "Ctrl/Cmd + Enter", i18nKey: "settings.shortcuts.runQuery" },
  { combo: "Ctrl/Cmd + F", i18nKey: "settings.shortcuts.focusSearch" },
  { combo: "Enter", i18nKey: "settings.shortcuts.commitSearch" },
  { combo: "Esc", i18nKey: "settings.shortcuts.closeDialog" },
];

export function ShortcutsSection() {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-dashed border-border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
        {t("settings.shortcuts.roadmap")}
      </div>
      <div className="divide-y divide-border/60 rounded-md border border-border">
        {SHORTCUTS.map((s) => (
          <div
            key={s.combo}
            className="flex items-center justify-between gap-4 px-3 py-2"
          >
            <span className="text-sm">{t(s.i18nKey)}</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {s.combo}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
