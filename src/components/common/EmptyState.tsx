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
 * The medallion is the illustration slot: when the sticker artwork (the 3D "H"
 * over the database cylinder) is available as an asset, it replaces the Lucide
 * glyph here, once, and every empty state picks it up.
 */

import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Glyph inside the medallion. Defaults to a neutral "nothing here" tray. */
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
  icon: Icon = Inbox,
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
            "relative flex items-center justify-center rounded-2xl border-2 bg-card shadow-elevation-1",
            compact ? "h-9 w-9" : "h-12 w-12",
            tone === "error"
              ? "border-destructive/40 text-destructive"
              : "border-border text-brand",
          )}
        >
          <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} aria-hidden />
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
