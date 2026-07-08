import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Compact segmented control — a single-choice toggle group styled as one
 * pill-bordered strip with a raised active segment. Replaces the app's several
 * hand-rolled variants (two full Buttons acting as a toggle, OS checkboxes as
 * filters, plain <button>s masquerading as tabs) with one accessible,
 * keyboard-navigable primitive.
 *
 * Deliberately created at first adoption (not speculatively): the UI overhaul
 * has three call sites (feedback kind, console filters, structure sections).
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Optional leading icon (e.g. a lucide glyph sized h-3.5). */
  icon?: React.ReactNode;
  /** Native tooltip / accessible hint for icon-heavy segments. */
  title?: string;
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "default",
  "aria-label": ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: "default" | "sm";
  "aria-label"?: string;
}) {
  // Left/Right arrows move the selection, matching a radiogroup/tablist.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return;
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % options.length
        : (i - 1 + options.length) % options.length;
    onValueChange(options[next].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Only the active segment stays in the tab order; arrows move
            // between the others (roving tabindex).
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius)-4px)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
