import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS } from "@/components/ui/styles";

// Shape and motion follow a Claude-style hairline language:
// every button carries a 1px edge, so a control reads as an object at rest
// rather than only once the pointer finds it. Two edges, one idea:
//
// - Unfilled variants (`outline`, `secondary`, `ghost`, `quiet`) take a
//   hairline derived from the *text* colour (`EDGE`), not from `--border`.
//   `--border` is tuned to separate panels, and on an imported VS Code theme it
//   can be anything from invisible to loud; 15% of the foreground stays legible
//   on every palette because it moves with the text it frames.
// - Filled variants take their own fill darkened by a fifth, plus a 1px inner
//   highlight — the edge of a physical key rather than a sticker outline.
//
// Corners sit on the `--radius` scale: 10px at full size, 8px on the dense and
// icon sizes, 6px on the 24px square. The transition lists properties
// explicitly rather than `transition-all`: `all` would also animate
// width/height, which makes a button holding a spinner (Run, Connect) visibly
// stretch when its label swaps.
const EDGE =
  "border border-foreground/15 hover:border-foreground/25";

/** A filled variant's edge: its own fill, darker, with a key-top highlight. */
const FILLED_EDGE =
  "border shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] active:scale-[0.98]";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-180 ease-out",
    CONTROL_FOCUS,
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        default: [
          FILLED_EDGE,
          "border-[color-mix(in_srgb,black_18%,var(--brand))] bg-brand text-brand-foreground hover:bg-brand-hover",
        ],
        destructive: [
          FILLED_EDGE,
          "border-[color-mix(in_srgb,black_18%,var(--destructive))] bg-destructive text-destructive-foreground hover:bg-destructive/90",
        ],
        // The secondary of the brief: transparent fill, hairline edge, grey hover.
        outline: [EDGE, "bg-transparent hover:bg-accent hover:text-accent-foreground"],
        secondary: [
          EDGE,
          "bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground",
        ],
        ghost: [EDGE, "hover:bg-accent hover:text-accent-foreground"],
        // Toolbar chrome: muted at rest, full-contrast under the pointer. The
        // only thing separating this from `ghost` is the resting colour, which
        // is exactly what the ~65 hand-rolled icon buttons all wrote out —
        // along with four different hover alphas. `IconButton` is built on it.
        quiet: [EDGE, "text-muted-foreground hover:bg-accent hover:text-foreground"],
        link: "text-brand underline-offset-4 hover:text-brand-hover hover:underline",
      },
      // The `xs`/`sm`/`md` density vocabulary is shared with Input, Textarea
      // and Select rather than each primitive inventing its own — see
      // `README.md`. `lg` and the three `icon*` sizes are outside it on
      // purpose: `lg` has a single call site, and an icon size is a *shape*
      // (a square), not a density.
      size: {
        md: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        xs: "h-7 rounded-md px-2 text-xs",
        lg: "h-10 px-6",
        icon: "h-8 w-8 rounded-md",
        "icon-sm": "h-7 w-7 rounded-md",
        // 6px, not 8px: a 24px square with an 8px corner reads as a pill.
        "icon-xs": "h-6 w-6 rounded-sm",
      },
      /**
       * Drop the edge, keep everything else. For a button that sits *inside*
       * something already framed or packed tight — the clear button in a search
       * field, the remove cross on a filter chip, a row action that appears on
       * hover, a menu-bar trigger — where a second outline is a box inside a
       * box. Listed after `variant` so `cn`'s tailwind-merge lets it win.
       */
      flat: {
        true: "border-transparent shadow-none hover:border-transparent",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
      flat: false,
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
      flat,
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
        className={cn(buttonVariants({ variant, size, flat, className }))}
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
