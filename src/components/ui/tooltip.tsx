import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * Marks that a `TooltipPrimitive.Provider` is in scope.
 *
 * Radix throws outright when a `Tooltip` renders with no provider above it, and
 * offers no way to ask whether one is there. That was tolerable while tooltips
 * were opt-in per call site; it stops being tolerable once `IconButton` puts one
 * behind every icon button in the app, because those components then become
 * unrenderable anywhere a provider is missing — in practice, every test that
 * touches one has to know to wrap it. This sentinel lets `SimpleTooltip` supply
 * its own provider when it must.
 *
 * The app's three window roots still declare one and should keep doing so: a
 * single provider is what makes the hover delay shared, and what lets one open
 * tooltip skip the next one's delay while the pointer is still travelling. The
 * fallback is a safety net, not the intended arrangement.
 */
const HasTooltipProvider = React.createContext(false);

const TooltipProvider = ({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <HasTooltipProvider.Provider value={true}>
    <TooltipPrimitive.Provider {...props}>{children}</TooltipPrimitive.Provider>
  </HasTooltipProvider.Provider>
);
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * **The `Portal` is not optional.** Radix does not portal tooltip content on
 * its own (unlike its dialog and select, and unlike the dropdown and context
 * menu as this app wraps them), so without it the tooltip renders in place in
 * the DOM — where an ancestor's `overflow` clips it and an ancestor's stacking
 * context lets a later sibling paint over it, `z-50` or not. Both happen in
 * this app: the connections panel scrolls, so a tooltip on a button near its
 * top edge was cut off and painted under the title bar.
 *
 * It was wrong from the start and barely visible while three files used the
 * themed tooltip. It is visible everywhere now that `IconButton` puts one
 * behind every icon button, which is the useful part: a latent bug in a
 * primitive surfaces the moment the primitive is actually adopted.
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      // Keep a tooltip off the viewport edges. Radix flips it to the other
      // side when it would not fit, which only helps if it knows how much room
      // to insist on — the default of 0 lets it sit flush against the edge.
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-elevation-2 duration-150 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-[0.98]",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
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
  const hasProvider = React.useContext(HasTooltipProvider);
  if (!label) return <>{children}</>;
  const tooltip = (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
