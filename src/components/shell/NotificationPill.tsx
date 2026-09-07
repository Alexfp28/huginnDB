/**
 * The one-line notification anatomy: a 32px pill that appears, says one thing
 * and leaves.
 *
 * It exists because the card was being spent on notifications that had nothing
 * to put in it — "Cell saved" occupied 380px, a medallion, a body slot and a
 * button row to deliver two words. Anything that genuinely needs those is a
 * card and never reaches this component: `surfaceFor` in `lib/notify` decides,
 * once, at the seam. So there is deliberately no `actions`, no `file` and no
 * close button here — not as a limitation to work around, but as the contract
 * that keeps the escalation rule honest.
 *
 * Dismissal is a click on the pill itself. A 20px close button inside 32px of
 * height is half the control, and the pill is small enough to be its own hit
 * target. Sonner's swipe does not reach it (see the `notif-pill-stack` rules
 * in `index.css`), which is the trade the click-anywhere gesture buys back.
 *
 * There is no drain hairline: the tick is what a card needs because a card has
 * to be *read*, and `raise()` gives a pill the base duration for the same
 * reason. Losing it also means `expandOnHover`'s timer freeze has no visible
 * acknowledgement on a pill — a known cost, recorded here so it is not
 * rediscovered as a bug.
 */

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  NOTIFICATION_KIND_VISUALS,
  type NotificationSurfaceKind,
} from "@/components/shell/notificationVisuals";
import type { NotificationDensity } from "@/types";

interface Props {
  kind: NotificationSurfaceKind;
  title: string;
  /** Faint monospaced tail — a count, an identifier. Already known to fit. */
  suffix?: string;
  /** Occurrences folded into this pill; anything above 1 shows a counter. */
  count?: number;
  /** `kind: "progress"` only — done/total, rendered as a percentage. */
  progress?: { done: number; total: number };
  density: NotificationDensity;
  /**
   * Which edge to hug inside Sonner's fixed-width `<li>`.
   *
   * The container sizes every custom toast to `--width` (`index.css`), and a
   * pill is intrinsically narrower, so without this it would sit against the
   * left edge of a 380px row however the stack is positioned. Fighting the
   * width itself is worse: Sonner leaves `left` unset for a centred stack and
   * drives the stacking animation through `transform`, so the `<li>` is not
   * ours to re-position.
   */
  align: "start" | "center" | "end";
  onDismiss: () => void;
}

/** Literal lookup, never an interpolated class — the JIT scans source as text. */
const ALIGN: Record<Props["align"], string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
};

export function NotificationPill({
  kind,
  title,
  suffix,
  count = 1,
  progress,
  density,
  align,
  onDismiss,
}: Props) {
  const k = NOTIFICATION_KIND_VISUALS[kind];
  const compact = density === "compact";
  const pct =
    kind === "progress" && progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  return (
    <div className={cn("flex w-full", ALIGN[align])}>
      <Button
        type="button"
        variant="secondary"
        size={compact ? "xs" : "sm"}
        // No `title`, and no `aria-label` either. A native tooltip needs a
        // hover the pill outlives by design, and an "aria-label" would replace
        // the accessible name with the word "close" — hiding the message from
        // exactly the reader that depends on Sonner's live region to hear it.
        // The label is the text, and the whole control is the dismiss target.
        onClick={onDismiss}
        className={cn(
          "max-w-full rounded-full bg-popover px-3 font-medium text-popover-foreground shadow-elevation-2",
          k.pill,
        )}
      >
        {/* The icon is a child rather than the `icon` prop, which is the
            pattern `ui/button` otherwise wants: here the glyph *is* the
            semantics (which kind this is) and has to carry the kind's tint,
            and the prop owns sizing only. */}
        <k.Icon
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            k.icon,
            // Indeterminate only: once there are numbers the percentage is the
            // live part and a spinning glyph beside it is two clocks.
            kind === "progress" && pct === null && "animate-spin",
          )}
        />
        <span className="truncate">{title}</span>
        {count > 1 && (
          <span className="shrink-0 rounded-sm bg-accent px-1.5 font-mono text-3xs font-semibold text-foreground">
            ×{count}
          </span>
        )}
        {/* Dropped in `compact` for the same reason the card drops its body
            line there: the detail is the first thing worth trading for density. */}
        {suffix && !compact && (
          <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
            {suffix}
          </span>
        )}
        {pct !== null && (
          <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
            {pct}%
          </span>
        )}
      </Button>
    </div>
  );
}
