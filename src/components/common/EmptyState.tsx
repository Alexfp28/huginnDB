/**
 * Shared empty-state frame.
 *
 * Empty screens were a single grey line of text wherever they appeared — the
 * one place in the app where nothing is happening and therefore, per the brand
 * visual brief, one of the few places allowed to show personality: a halftone
 * wash, an outlined medallion holding the glyph, a title and an optional hint.
 * They share one frame so "no connections", "no rows", "nothing logged yet" and
 * "no match" read as the same family instead of four ad-hoc paragraphs.
 *
 * Halftone lives here and NOT behind a grid, a tree or an editor (the brief is
 * explicit, and a repeating pattern under data fights it for attention) — which
 * is exactly why it's attached to this component rather than left as a utility
 * for any surface to sprinkle on.
 *
 * The illustration is the sticker mark itself (the 3D "H" over the database
 * cylinder), which is what makes the family a family — every empty screen shows
 * the same character. The per-state Lucide glyph rides along as a small badge
 * on its corner, so "nothing logged yet" and "no match for that filter" stay
 * distinguishable at a glance without each inventing its own artwork.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /**
   * Per-state glyph, shown as a badge on the mark's corner. Optional: with no
   * icon the mark stands alone (the right call when the title already says
   * everything, e.g. a first-run screen).
   */
  icon?: LucideIcon;
  /** The message. Short sentence; wraps at a readable measure. */
  title: string;
  /** Optional second line — what to do about it. */
  hint?: ReactNode;
  /** Optional call to action (a `Button`, usually). */
  action?: ReactNode;
  /**
   * `error` recolours the medallion to the destructive accent. Same geometry
   * and border weight as the neutral tone — per the brief, the colour is the
   * only thing that changes between states.
   */
  tone?: "neutral" | "error";
  /** `sm` for narrow side panels (saved queries, console); `md` elsewhere. */
  size?: "sm" | "md";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  tone = "neutral",
  size = "md",
  className,
}: EmptyStateProps) {
  const compact = size === "sm";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-10",
        className,
      )}
    >
      <div className="relative flex items-center justify-center">
        {/* The comic halftone, faded from the centre so it reads as printing
            texture behind the mark rather than a tiled background. */}
        <span
          aria-hidden
          className="halftone-centered pointer-events-none absolute -inset-7 rounded-full"
        />
        <span
          className={cn(
            "relative block",
            compact ? "h-11 w-11" : "h-16 w-16",
          )}
        >
          {/* The mark carries its own sticker outline, so it needs no
              medallion frame around it — that would be a second border. */}
          <img
            src="/image/huginn-mark-256.png"
            alt=""
            width={256}
            height={256}
            className="h-full w-full select-none"
            draggable={false}
          />
          {Icon && (
            <span
              className={cn(
                "absolute -bottom-1 -right-1 flex items-center justify-center rounded-full border-2 bg-card shadow-elevation-1",
                compact ? "h-5 w-5" : "h-6 w-6",
                tone === "error"
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-brand",
              )}
            >
              <Icon
                className={compact ? "h-2.5 w-2.5" : "h-3 w-3"}
                aria-hidden
              />
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p
          className={cn(
            "max-w-[42ch] font-medium text-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {title}
        </p>
        {hint && (
          <p className="max-w-[46ch] text-xs text-muted-foreground">{hint}</p>
        )}
      </div>
      {action}
    </div>
  );
}
