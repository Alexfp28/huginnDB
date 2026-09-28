/**
 * A titled card — the unit a Preferences section is built from.
 *
 * Before this, a section was one flat list of rows with hairlines between them,
 * so eleven editor settings read as one undifferentiated column and the only
 * structure a long section had was the order someone happened to add rows in.
 * A group gives its contents a name ("Display", "Pool limits") and a surface,
 * which is what makes a section scannable once it passes six or seven rows.
 *
 * Two shapes, one look:
 * - **Rows** (the default): the card holds `PrefRow`s edge to edge. Rows find
 *   out they are inside a group through context rather than a prop, so the same
 *   `PrefRow` still renders flush where it is used on its own (the shortcut
 *   list).
 * - **`padded`**: the card holds free content — a form, a code snippet, a
 *   probe result — with the same inset the rows have. Rows are not expected
 *   there, so the context stays off and a stray one would not double its inset.
 *
 * A card that needs its own chrome (a toolbar over a tree, a list of rows with
 * their own padding) uses the default shape and draws the chrome itself; see
 * `ConnectionTreeCard`.
 */

import { createContext } from "react";
import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";

/** True for a `PrefRow` rendered inside a row-shaped `PrefGroup` card. */
export const PrefGroupContext = createContext(false);

interface Props {
  title?: string;
  /** One or two lines under the title: what the group is for, a caveat. */
  description?: React.ReactNode;
  /** Right-aligned beside the title — a count, or a button that acts on the
   *  whole group. */
  action?: React.ReactNode;
  /** Free content with an inset, rather than edge-to-edge rows. */
  padded?: boolean;
  className?: string;
  /** Classes for the card itself, e.g. a minimum height. */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function PrefGroup({
  title,
  description,
  action,
  padded = false,
  className,
  bodyClassName,
  children,
}: Props) {
  return (
    <section className={cn("space-y-2", className)}>
      {(title || action || description) && (
        <div className="px-0.5">
          {(title || action) && (
            <div className="flex min-h-6 items-center justify-between gap-2">
              {title && <h3 className={MICRO_HEADING}>{title}</h3>}
              {action && (
                <div className="flex shrink-0 items-center gap-1.5">{action}</div>
              )}
            </div>
          )}
          {description && (
            <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-card/40",
          padded && "space-y-3 p-4",
          bodyClassName,
        )}
      >
        <PrefGroupContext.Provider value={!padded}>{children}</PrefGroupContext.Provider>
      </div>
    </section>
  );
}

/** The quiet count that sits in a group's `action` slot ("3 of 9 exposed"). */
export function GroupCount({ children }: { children: React.ReactNode }) {
  return <span className="text-2xs text-muted-foreground">{children}</span>;
}
