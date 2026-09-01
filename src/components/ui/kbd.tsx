/**
 * A key cap: `<Kbd>↵</Kbd>`, `<Kbd>Ctrl+S</Kbd>`.
 *
 * The class string was written out eight times across the command palette, the
 * tab switcher and the cell editor. Worth a component rather than a shared
 * constant because "how a key looks" is a UI decision this app makes in one
 * place, and the semantic `<kbd>` element comes with it.
 *
 * Combos should be rendered through `formatComboForDisplay` first so `Ctrl`
 * appears as ⌘ on macOS.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export const Kbd = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn(
      "rounded-sm border border-border bg-muted px-1 font-mono leading-none",
      className,
    )}
    {...props}
  />
));
Kbd.displayName = "Kbd";
