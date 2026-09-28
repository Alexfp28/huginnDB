/**
 * A titled card of `PrefRow`s — the unit a Preferences section is built from.
 *
 * Before this, a section was one flat list of rows with hairlines between them,
 * so eleven editor settings read as one undifferentiated column and the only
 * structure a long section had was the order someone happened to add rows in.
 * A group gives the rows a name ("Display", "Pool limits") and a surface, which
 * is what makes a section scannable once it passes six or seven rows.
 *
 * Rows find out they are inside a group through context rather than a prop, so
 * the same `PrefRow` still renders flush where it is used on its own (the
 * shortcut list, the JSON Schema behaviour toggles, Appearance's group boxes).
 */

import { createContext } from "react";
import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";

/** True for a `PrefRow` rendered inside a `PrefGroup` card. */
export const PrefGroupContext = createContext(false);

interface Props {
  title?: string;
  /** Right-aligned beside the title — a button that acts on the whole group. */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function PrefGroup({ title, action, className, children }: Props) {
  return (
    <section className={cn("space-y-2", className)}>
      {(title || action) && (
        <div className="flex min-h-6 items-center justify-between gap-2 px-0.5">
          {title && <h3 className={MICRO_HEADING}>{title}</h3>}
          {action}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-card/40">
        <PrefGroupContext.Provider value>{children}</PrefGroupContext.Provider>
      </div>
    </section>
  );
}
