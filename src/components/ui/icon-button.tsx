import * as React from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { REVEAL_ON_HOVER } from "@/components/ui/styles";

/**
 * A square, dense icon control with a themed tooltip — the toolbar and row
 * button the app wrote out by hand about 65 times across 38 files, with four
 * different hover alphas and three paddings between them.
 *
 * Two decisions do the actual work:
 *
 * **`icon` is the component, not a child.** That is what takes the glyph-size
 * decision away from the call site, and that decision is where `h-3` / `h-3.5`
 * / `h-4` on visually identical buttons came from.
 *
 * **`label` is required and `title` is removed from the props type.** A bare
 * icon button with no accessible name is a bug, and a native `title=` is the
 * OS tooltip — a different delay, a different look, and 219 of them were
 * competing with the themed one. Making it a compile error is cheaper than a
 * lint rule and cannot drift.
 *
 * Needs a `TooltipProvider` above it. All three window roots have one.
 */

/** Hover treatment. The resting colour is muted in every case; only what the
 *  pointer reveals differs, so a destructive row action can read as dangerous
 *  without shouting at rest. */
const TONE = {
  quiet: "",
  destructive: "hover:bg-destructive/10 hover:text-destructive",
  brand: "hover:bg-brand/10 hover:text-brand",
} as const;

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "title"
> {
  /** Accessible name *and* tooltip text. Required on purpose. */
  label: string;
  icon: LucideIcon;
  /** `sm` is 28px (the default), `xs` is 24px for the tightest chrome. */
  size?: "sm" | "xs";
  tone?: keyof typeof TONE;
  /** Which side the tooltip opens on. */
  side?: "top" | "right" | "bottom" | "left";
  /** Hidden until its container is hovered or this button is focused. The
   *  container must carry the matching `group/<name>`. */
  revealOnHover?: keyof typeof REVEAL_ON_HOVER;
  /** Swap the icon for a spinner and disable the button. */
  loading?: boolean;
  /**
   * Emit a native `title=` instead of the themed tooltip. The escape hatch for
   * the one place it is correct: inside open menu content (a `DropdownMenuItem`,
   * a swatch inside `DropdownMenuContent`), where the Radix tooltip fights the
   * menu's own hover and portal handling. See `tooltip.tsx`.
   */
  nativeTitle?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      icon,
      size = "sm",
      tone = "quiet",
      side,
      revealOnHover,
      loading = false,
      nativeTitle = false,
      className,
      ...props
    },
    ref,
  ) => {
    const button = (
      <Button
        ref={ref}
        variant="quiet"
        size={size === "xs" ? "icon-xs" : "icon-sm"}
        icon={icon}
        loading={loading}
        aria-label={label}
        title={nativeTitle ? label : undefined}
        className={cn(
          TONE[tone],
          revealOnHover && REVEAL_ON_HOVER[revealOnHover],
          className,
        )}
        {...props}
      />
    );
    if (nativeTitle) return button;
    return (
      <SimpleTooltip label={label} side={side}>
        {button}
      </SimpleTooltip>
    );
  },
);
IconButton.displayName = "IconButton";
