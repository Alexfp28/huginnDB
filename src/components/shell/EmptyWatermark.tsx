/**
 * Empty-state screen shown when no tabs are open.
 *
 * Split out of `TabbedArea`, and with it the last copy of the key-cap markup
 * that `components/ui/kbd.tsx` exists to own — this one was inside a god file,
 * which is why the earlier sweep of eight call sites missed it. The overrides
 * passed to it reproduce the previous look exactly, `leading-normal` included,
 * since the shared component sets `leading-none` for the denser rows in the
 * command palette.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { WorkspacePicker } from "@/components/connection/WorkspacePicker";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { ConnectionDialog } from "@/components/connection/dialogs/ConnectionDialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { formatComboForDisplay, getBinding } from "@/lib/keybindings";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { isMainWindow } from "@/lib/window";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { useUi } from "@/stores/session/ui";

/**
 * Empty-state screen shown when no tabs are open.
 *
 * It used to be a logo, a line of text and a "New query" button floating
 * below the workspace picker (#110) with no relation to each other, plus a
 * lot of dead space on wide windows — the reported inconsistency. This
 * composes the same pieces (hero, hint, picker) into one column with a
 * shared visual frame: the "new query" action now sits inline with the hint
 * it belongs to instead of hanging on its own underneath, the picker gets a
 * console-style card so it reads as the deliberate focal panel rather than a
 * loose block, and a subtle dot-grid + brand glow fills the backdrop instead
 * of leaving flat empty space. A fresh install (no profiles, no picker to
 * show) now gets an actual "New connection" call to action instead of just
 * static hint text — previously the least useful screen in the app at the
 * moment you most need a way in. The keyboard-shortcut footer reads the
 * user's live rebindings (`getBinding`), never hardcoded combos, and doubles
 * as a real trigger for the command palette / preferences.
 */
export function EmptyWatermark() {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  const hasProfiles = useConnections((s) => s.profiles.length > 0);
  const environments = useEnvironments((s) => s.environments);
  // Same guard as `WorkspacePicker` itself — left main-window-only for now,
  // see that component's comment.
  const showEnvironments =
    isMainWindow() && environments.length > 1;
  const showPicker = hasProfiles || showEnvironments;

  const [connDialogOpen, setConnDialogOpen] = useState(false);
  const togglePalette = useCommandPalette((s) => s.toggle);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const paletteCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleCommandPalette"),
  );
  const settingsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openSettings"),
  );

  function openNewQuery() {
    if (!connectionId) return;
    openQueryTab(connectionId);
  }

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* The brand halftone, not a hand-rolled grid of `--border` dots: this
            is the same lattice the splash and the empty states use, so all four
            empty surfaces share one texture. The pitch is coarsened to 16px
            because this one covers the whole workspace — at the medallion's 9px
            it reads as noise — and the utility's own mask carries it into the
            corners instead of dying in an ellipse two thirds of the way out. */}
        <div className="halftone-centered absolute inset-0 [--halftone-pitch:16px]" />
        {/* Two blooms rather than one: a wide wash from above for the surface,
            and a tighter one behind the lockup as its light source. */}
        <div className="absolute left-1/2 top-[-140px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-brand/20 blur-[110px]" />
      </div>

      <div className="relative z-10 flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-7 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          {/* The full sticker lockup, not the mark plus a mono wordmark: an
              empty workspace is one of the few places the brief hands the
              brand its full voice, and the lockup already carries the name, so
              repeating it in type underneath was saying it twice. Served at
              512px for a ~240px box (2x DPI); the 1024px variant exists for
              docs, and the untouched master lives in `brand/`. */}
          <div className="relative">
            <div className="absolute inset-0 -z-10 scale-125 rounded-[2rem] bg-brand/25 blur-2xl" />
            <img
              src="/image/huginn-lockup-512.png"
              alt="HuginnDB"
              width={512}
              height={288}
              className="h-auto w-60 select-none drop-shadow-[0_6px_24px_hsl(var(--brand)/0.35)]"
              draggable={false}
            />
          </div>
          {!showPicker && (
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("tabs.emptyConnectFirst")}
            </p>
          )}
        </div>

        {showPicker ? (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2.5 rounded-full border border-border/70 bg-card/60 py-1.5 pl-4 pr-1.5 text-sm text-muted-foreground">
              <span>
                {connectionId
                  ? t("tabs.emptyOpenSomething")
                  : t("tabs.emptyConnectFirst")}
              </span>
              {connectionId && (
                <Button
                  size="sm"
                  className="h-7 gap-1.5 rounded-full px-3"
                  onClick={openNewQuery}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("tabs.newQuery")}
                </Button>
              )}
            </div>

            <div className="w-full rounded-2xl border border-border/70 bg-card/50 p-5 shadow-sm">
              <WorkspacePicker />
            </div>
          </>
        ) : (
          <Button className="gap-1.5" onClick={() => setConnDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("menu.file.newConnection")}
          </Button>
        )}
      </div>

      <div className="relative z-10 flex items-center gap-5 pb-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => togglePalette()}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
        >
          <Kbd className="px-1.5 py-0.5 text-[10px] font-medium leading-normal text-muted-foreground">
            {formatComboForDisplay(paletteCombo)}
          </Kbd>
          {t("commandPalette.title")}
        </button>
        <button
          type="button"
          onClick={() => openSettings()}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
        >
          <Kbd className="px-1.5 py-0.5 text-[10px] font-medium leading-normal text-muted-foreground">
            {formatComboForDisplay(settingsCombo)}
          </Kbd>
          {t("settings.title")}
        </button>
      </div>

      <ConnectionDialog
        open={connDialogOpen}
        onOpenChange={setConnDialogOpen}
        initial={null}
      />
    </div>
  );
}
