/**
 * "+N notifications more" — the counter `NotificationPrefs.maxVisible`'s own
 * doc comment already promised ("the rest collapse behind a counter") but
 * Sonner never draws: past `visibleToasts`, it just stops rendering the
 * overflow, with no indication anything is behind the fold.
 *
 * This has to live outside `[data-sonner-toaster]` — that container is
 * Sonner's own DOM, not a slot we can inject into — so it is a second,
 * separately positioned fixed element, mounted as a sibling of `<Toaster>`
 * (`App.tsx`, `DetachedTabWindow.tsx`). It mirrors the toaster's corner
 * (`notifications.position`) but not its real stacked height: Sonner keeps
 * per-toast heights as private component state, not a public API, so
 * `STACK_PEEK_PX` is a fixed approximation of the collapsed stack's footprint
 * rather than a pixel-accurate "just past the last card".
 */

import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useHiddenToastCount } from "@/lib/notify";
import { usePreferences } from "@/stores/preferences/preferences";

/** Mirrors the offset passed to `<Toaster>` in App.tsx / DetachedTabWindow.tsx. */
const BASE_OFFSET = { top: 12, bottom: 32, left: 16, right: 16 };
/** Rough footprint of a collapsed (non-hovered) stack peeking behind the front card. */
const STACK_PEEK_PX = 88;

export function NotificationOverflowPill() {
  const { t } = useTranslation();
  const count = useHiddenToastCount();
  const position = usePreferences((s) => s.prefs.notifications.position);

  if (count <= 0) return null;

  const [vertical, horizontal] = position.split("-") as [
    "top" | "bottom",
    "left" | "center" | "right",
  ];
  const style: React.CSSProperties = { position: "fixed", zIndex: 40 };
  if (vertical === "top") style.top = BASE_OFFSET.top + STACK_PEEK_PX;
  else style.bottom = BASE_OFFSET.bottom + STACK_PEEK_PX;
  if (horizontal === "left") style.left = BASE_OFFSET.left;
  else if (horizontal === "right") style.right = BASE_OFFSET.right;
  else {
    style.left = "50%";
    style.transform = "translateX(-50%)";
  }

  return (
    <div
      style={style}
      className="pointer-events-none flex items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-3xs font-medium text-muted-foreground shadow-elevation-2"
    >
      <ChevronDown className="h-2.5 w-2.5" />
      {t("notifications.center.moreHidden", { count })}
    </div>
  );
}
