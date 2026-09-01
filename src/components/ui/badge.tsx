import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A small status pill.
 *
 * Created on first adoption rather than speculatively (the norm `segmented.tsx`
 * records): the app had one private `Badge` inside `MongoIndexesTab` plus about
 * thirty hand-rolled `<span>` pills, which between them used four type scales
 * and three background treatments for the same idea.
 *
 * `tone` names the *meaning*, not the colour, which is what keeps a badge from
 * quietly becoming the place a call site reaches for an arbitrary hue.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded border font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted/40 text-muted-foreground",
        brand: "border-brand/40 bg-brand/10 text-brand",
        success: "border-success/40 bg-success/10 text-success",
        warning: "border-warning/40 bg-warning/10 text-warning",
        destructive: "border-destructive/40 bg-destructive/10 text-destructive",
        outline: "border-border bg-transparent text-foreground",
      },
      size: {
        sm: "px-1.5 py-0.5 text-2xs",
        xs: "px-1 py-0 text-3xs",
      },
      mono: { true: "font-mono", false: "" },
    },
    defaultVariants: { tone: "neutral", size: "sm", mono: false },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** For the handful of badges that are actually buttons or links. */
  asChild?: boolean;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, size, mono, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "span";
    return (
      <Comp
        ref={ref}
        className={cn(badgeVariants({ tone, size, mono, className }))}
        {...props}
      />
    );
  },
);
Badge.displayName = "Badge";

export { badgeVariants };
