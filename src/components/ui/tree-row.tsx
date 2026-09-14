/**
 * One clickable row in the schema tree: a connection's database, a database's
 * schema, a section header.
 *
 * Four call sites had hand-written the same `<button>` — full width, the same
 * gap and padding, the same `hover:bg-accent`, and the same
 * `ring-1 ring-inset ring-ring` driven by "is my context menu open on me",
 * which exists because right-clicking a row moves the pointer onto the menu
 * and the row stops looking hovered exactly when the user needs to know which
 * one they hit. Four copies of a rule nobody would think to keep in sync.
 *
 * Deliberately thin. It owns the chrome and nothing else: every row's content
 * (chevron, icon, name, badges) stays at the call site, because that is the
 * part that genuinely differs between a database node and an index section.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export const TreeRow = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    /** True while this row's context menu is open, for the focus ring. */
    menuOpen?: boolean;
  }
>(({ className, menuOpen, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "flex w-full items-center gap-1 px-2 py-1.5 hover:bg-accent",
      menuOpen && "ring-1 ring-inset ring-ring",
      className,
    )}
    {...props}
  />
));
TreeRow.displayName = "TreeRow";
