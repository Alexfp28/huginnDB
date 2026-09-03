/**
 * Persistent, unmissable ribbon identifying THIS window when several are
 * open — mirrors `SandboxRibbon`'s "you might be in the wrong one" role, but
 * for window identity instead of build flavor: a solid tint, an icon, and
 * text naming which of the four window shapes (`windowKindOf`) this is,
 * since a color alone doesn't say "this is the main window" vs "this is a
 * duplicate".
 *
 * Hidden while only one HuginnDB window is open — the whole point is telling
 * windows apart, which is moot with nothing to confuse it with. The count
 * comes from `useWindowRegistry` (backed by Tauri's own window list, kept
 * fresh by `startWindowListBridge` — see that module for why the underlying
 * event is a global broadcast rather than a per-window `emit_to`).
 *
 * Both the ribbon's pastel background and its accent dot come from
 * `windowColor.ts`, sharing one hue derived from `getCurrentWindow().label` —
 * see that module's doc for why this reads as "random" in practice for
 * secondary windows and stays fixed for the main one. Text is a fixed dark
 * color rather than a theme token: the pastel background is light regardless
 * of the app's own light/dark theme, same reasoning as `SandboxRibbon`'s
 * amber bar forcing dark text in both.
 *
 * Mounted in every window root (`App.tsx`, `DetachedTabWindow.tsx`,
 * `PulseWindow.tsx`) right after `SandboxRibbon`, which this visually
 * continues — canary flavor first, window identity second.
 */

import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { colorForWindowLabel, ribbonColorForWindowLabel } from "@/lib/windowColor";
import { windowKindOf } from "@/lib/window";
import { useWindowRegistry } from "@/stores/session/windowRegistry";

const RIBBON_TEXT_COLOR = "rgba(0, 0, 0, 0.75)";

export function WindowColorBadge() {
  const { t } = useTranslation();
  const count = useWindowRegistry((s) => s.count);

  if (count <= 1) return null;

  const label = getCurrentWindow().label;
  const kind = windowKindOf(label);

  return (
    <SimpleTooltip
      label={t("shell.windowLabelTooltip", { label })}
      side="bottom"
    >
      <div
        role="status"
        aria-live="polite"
        className="flex h-6 shrink-0 items-center gap-2 border-b border-black/10 px-3 text-[11px] font-semibold"
        style={{
          backgroundColor: ribbonColorForWindowLabel(label),
          color: RIBBON_TEXT_COLOR,
        }}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: colorForWindowLabel(label) }}
        />
        <AppWindow className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{t(`shell.windowKind.${kind}`)}</span>
        <span className="opacity-70">·</span>
        <span className="opacity-70">{t("shell.windowCount", { count })}</span>
      </div>
    </SimpleTooltip>
  );
}
