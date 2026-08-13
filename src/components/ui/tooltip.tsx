import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md",
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/**
 * Convenience wrapper for the common case: a single trigger element with a
 * themed tooltip label. Lets call sites replace a native `title="…"` with one
 * concise element instead of the full Root/Trigger/Content trio. Falls back to
 * rendering the child bare when there's no label. Use the primitives directly
 * for anything richer (rich content, controlled open, custom side/align).
 *
 * NOTE: use this for standalone chrome buttons AND for menu/context triggers
 * — but `SimpleTooltip` must be the OUTER wrapper, with `*Trigger asChild`
 * wrapping the actual button INSIDE it (`<SimpleTooltip><ContextMenuTrigger
 * asChild><button/></ContextMenuTrigger></SimpleTooltip>`), never the other
 * way around: nesting `*Trigger asChild` around `SimpleTooltip` compiles and
 * looks plausible, but the trigger's `asChild` clones onto `SimpleTooltip`'s
 * own `TooltipTrigger` wrapper rather than the underlying button, and the
 * context/dropdown menu silently never opens (confirmed against
 * `EnvironmentRail`'s right-click menu). What it is NOT for is a tooltip
 * nested *inside* open menu content (a DropdownMenuItem or a swatch inside
 * DropdownMenuContent): there the Radix tooltip fights the menu's own hover/
 * portal handling, so those spots keep a native `title=""` — a plain OS
 * tooltip that doesn't conflict. Don't migrate in-menu-item titles.
 */
export function SimpleTooltip({
  label,
  children,
  side,
  delayDuration,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>["side"];
  /** Override the provider's hover delay. Use a shorter one where hovering is
   *  a scanning gesture rather than a deliberate "what is this?" (the tab
   *  strip: the tooltip is how a truncated tab reveals its full name). */
  delayDuration?: number;
}) {
  if (!label) return <>{children}</>;
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
