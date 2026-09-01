import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS } from "@/components/ui/styles";

// Shape and motion follow the brand visual language: 12px corners on the
// full-size button (`rounded-xl`, deliberately outside the `--radius` scale —
// see index.css), a 2px edge on the *filled* variants so they carry the logo's
// outlined-sticker weight, and a hover that lifts 1px into a short brand glow.
// The transition lists properties explicitly rather than `transition-all`:
// `all` would also animate width/height, which makes a button holding a
// spinner (Run, Connect) visibly stretch when its label swaps.
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-180 ease-out",
    CONTROL_FOCUS,
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        default:
          "border-2 border-brand bg-brand text-brand-foreground shadow-elevation-1 hover:border-brand-hover hover:bg-brand-hover hover:-translate-y-px hover:shadow-brand active:translate-y-0 active:shadow-none",
        destructive:
          "border-2 border-destructive bg-destructive text-destructive-foreground shadow-elevation-1 hover:bg-destructive/90 hover:-translate-y-px hover:shadow-[0_2px_12px_color-mix(in_srgb,var(--destructive)_35%,transparent)] active:translate-y-0 active:shadow-none",
        // The secondary of the brief: transparent fill, grey edge, grey hover.
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // Toolbar chrome: muted at rest, full-contrast under the pointer. The
        // only thing separating this from `ghost` is the resting colour, which
        // is exactly what the ~65 hand-rolled icon buttons all wrote out —
        // along with four different hover alphas. `IconButton` is built on it.
        quiet: "text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-brand underline-offset-4 hover:text-brand-hover hover:underline",
      },
      // The `xs`/`sm`/`md` density vocabulary is shared with Input, Textarea
      // and Select rather than each primitive inventing its own — see
      // `README.md`. `lg` and the three `icon*` sizes are outside it on
      // purpose: `lg` has a single call site, and an icon size is a *shape*
      // (a square), not a density.
      size: {
        md: "h-9 px-4 py-2",
        // Dense sizes step down to the 10px `lg` radius: a 12px corner on a
        // 32px square control reads as a blob rather than a button.
        sm: "h-8 rounded-lg px-3 text-xs",
        xs: "h-7 rounded-lg px-2 text-xs",
        lg: "h-10 px-6",
        icon: "h-8 w-8 rounded-lg",
        "icon-sm": "h-7 w-7 rounded-lg",
        // 8px, not 10px: a 24px square with a 10px corner is a circle.
        "icon-xs": "h-6 w-6 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

type ButtonBaseProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

/**
 * `loading` and `asChild` are mutually exclusive in the type, not merely
 * documented as incompatible: `asChild` hands rendering to `Slot`, which takes
 * exactly one child, so a spinner cannot be injected alongside it. Every
 * `asChild` in the app is a literal, so this costs nothing and turns a silent
 * no-op into a compile error.
 */
export type ButtonProps = ButtonBaseProps &
  (
    | {
        asChild?: false;
        /**
         * Leading icon, passed as the component rather than as a child. That is
         * what lets the button own the glyph's size — the ~90 hand-written
         * `<Icon className="mr-1.5 h-3.5 w-3.5" />` children in the app are all
         * a call site making that decision, and disagreeing about it. The
         * spacing comes from the base `gap-2`, so no margin is needed either.
         */
        icon?: LucideIcon;
        /** Show a spinner, and disable the button while it spins. */
        loading?: boolean;
        /** Replaces the label while `loading` (e.g. "Dropping…"). */
        loadingLabel?: React.ReactNode;
      }
    | {
        asChild: true;
        icon?: never;
        loading?: never;
        loadingLabel?: never;
      }
  );

/** Glyph size per button size — the label's scale, not a fixed 16px. */
const ICON_SIZE: Record<NonNullable<ButtonBaseProps["size"]>, string> = {
  md: "h-4 w-4",
  lg: "h-4 w-4",
  sm: "h-3.5 w-3.5",
  xs: "h-3.5 w-3.5",
  icon: "h-4 w-4",
  "icon-sm": "h-3.5 w-3.5",
  "icon-xs": "h-3 w-3",
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      icon: Icon,
      loading = false,
      loadingLabel,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const glyph = ICON_SIZE[size ?? "md"];
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {/* The spinner *replaces* the icon rather than joining it, which is
                what the call sites this consolidates all did by hand. With no
                icon it simply leads the label. */}
            {loading ? (
              <Loader2 className={cn(glyph, "animate-spin")} />
            ) : (
              Icon && <Icon className={glyph} />
            )}
            {loading && loadingLabel !== undefined ? loadingLabel : children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
