import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
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
        link: "text-brand underline-offset-4 hover:text-brand-hover hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        // Dense sizes step down to the 10px `lg` radius: a 12px corner on a
        // 32px square control reads as a blob rather than a button.
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-8 w-8 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
