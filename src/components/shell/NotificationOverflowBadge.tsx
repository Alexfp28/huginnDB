/**
 * "+N notifications more" — the counter `NotificationPrefs.maxVisible`'s own
 * doc comment already promised ("the rest collapse behind a counter") but
 * Sonner never draws: past `visibleToasts`, it just stops rendering the
 * overflow, with no indication anything is behind the fold.
 *
 * This has to live outside `[data-sonner-toaster]` — that container is
 * Sonner's own DOM, not a slot we can inject into — so it is a second,
 * separately positioned fixed element, mounted as a sibling of `<Toaster>`
 * by `NotificationHosts`. It mirrors the toaster's corner
 * (`notifications.position`) but not its real stacked height, which is why
 * `CARD_STACK_PEEK_PX` is an approximation (see `notificationPosition.ts`).
 *
 * Named "badge", not "pill": the pill is the one-line notification anatomy
 * (`NotificationPill`), and two things called a pill in the same subsystem is
 * one too many.
 */

import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useHiddenToastCount, type NotificationSurface } from "@/lib/notify";
import {
  CARD_STACK_PEEK_PX,
  NOTIFICATION_OFFSET,
  PILL_STACK_PEEK_PX,
} from "@/lib/notificationPosition";
import { usePreferences } from "@/stores/preferences/preferences";

interface Props {
  /** Which stack this badge counts. Each host folds independently. */
  host: NotificationSurface;
}

export function NotificationOverflowBadge({ host }: Props) {
  const { t } = useTranslation();
  const count = useHiddenToastCount(host);
  const cardPosition = usePreferences((s) => s.prefs.notifications.position);
  const pillPosition = usePreferences((s) => s.prefs.notifications.pillPosition);

  if (count <= 0) return null;

  const position = host === "pill" ? pillPosition : cardPosition;
  const peek = host === "pill" ? PILL_STACK_PEEK_PX : CARD_STACK_PEEK_PX;

  const [vertical, horizontal] = position.split("-") as [
    "top" | "bottom",
    "left" | "center" | "right",
  ];
  const style: React.CSSProperties = { position: "fixed", zIndex: 40 };
  if (vertical === "top") style.top = NOTIFICATION_OFFSET.top + peek;
  else style.bottom = NOTIFICATION_OFFSET.bottom + peek;
  if (horizontal === "left") style.left = NOTIFICATION_OFFSET.left;
  else if (horizontal === "right") style.right = NOTIFICATION_OFFSET.right;
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
