/**
 * Reusable row layout for a single preference: label + description on the
 * left, control on the right. All settings sections compose these.
 *
 * A row that passes `prefId` becomes addressable: the command palette can send
 * the user straight to it (`useSettingsDialog.openAtPref`), and the row scrolls
 * itself into view and flashes a ring so the setting is findable in a long
 * section. The id must match the `prefId` the palette's settings registry uses
 * for that preference (`src/lib/commandPalette/settingsRegistry.ts`) — the two
 * halves are joined by that string alone. `PrefId` narrows it to a real
 * preference path so a mismatch is a compile error instead of "the section
 * opens, nothing is highlighted".
 */

import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type { PrefId } from "@/lib/prefId";
import { cn } from "@/lib/utils";

/** How long the ring stays on after a jump. */
const FLASH_MS = 1600;

interface Props {
  label: string;
  description?: string;
  htmlFor?: string;
  /** Stable id making this row a jump target for the command palette. */
  prefId?: PrefId;
  children: React.ReactNode;
}

export function PrefRow({
  label,
  description,
  htmlFor,
  prefId,
  children,
}: Props) {
  const highlightPrefId = useSettingsDialog((s) => s.highlightPrefId);
  const clearHighlight = useSettingsDialog((s) => s.clearHighlight);
  const [flashing, setFlashing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Consume the request as soon as it lands: clearing the store immediately
  // (rather than after the timeout) keeps the flash tied to the navigation that
  // asked for it, so re-opening the same section later doesn't replay it.
  useEffect(() => {
    if (!prefId || highlightPrefId !== prefId) return;
    clearHighlight();
    setFlashing(true);
    // The section pane has just mounted; wait a frame so the scroll lands on a
    // laid-out element rather than a zero-height one.
    const raf = requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    const timer = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [prefId, highlightPrefId, clearHighlight]);

  return (
    <div
      ref={ref}
      data-pref-id={prefId}
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border/60 py-3 last:border-b-0",
        // One blue pulse on arrival (`animate-brand-flash`, ~0.5s) settling
        // into the persistent ring — the "small blue spark when an action
        // completes" microdetail of the brand language, on the one navigation
        // that genuinely completes somewhere the user can't see yet.
        flashing &&
          "-mx-2 animate-brand-flash rounded-md bg-brand/10 px-2 ring-1 ring-brand/60 transition-colors",
      )}
    >
      <div className="flex-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && (
          <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
