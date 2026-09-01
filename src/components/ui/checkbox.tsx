import * as React from "react";
import { cn } from "@/lib/utils";
import { fieldFocus } from "@/components/ui/styles";

/**
 * A checkbox, wrapping the native input.
 *
 * Deliberately not `@radix-ui/react-checkbox`. The native control already gives
 * us `indeterminate`, form semantics and the OS's own focus handling for free,
 * and it looks right in all 35 places the app was using it directly — so a
 * Radix version would mean a new dependency (which this repo asks about first),
 * reimplementing the mixed state, and changing how every one of those 35 spots
 * looks, in exchange for nothing anyone had asked for.
 *
 * What it does fix is the spread underneath: four sizes, and `accent-brand` in
 * twenty places against `accent-primary` in twelve — and `--primary` is
 * near-black, not the brand blue, so the same control rendered grey in twelve
 * spots and blue in twenty. That token was corrected on its own; this makes it
 * unrepeatable.
 */
export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "size"
> {
  /**
   * The mixed state. Applied through a callback ref because the DOM does not
   * expose it as an attribute — which is why the four call sites that needed it
   * each reached for a ref of their own.
   */
  indeterminate?: boolean;
  size?: "sm" | "xs";
  /**
   * Wraps the input in a `<label>` with this text to its right.
   *
   * Without it the bare `<input>` is returned, with no wrapper element at all.
   * That is load-bearing rather than tidy: several call sites nest the input
   * inside a label or a table cell they already own, and one documents that
   * nesting as the reason its row is clickable.
   */
  label?: React.ReactNode;
}

const SIZE = {
  sm: "h-3.5 w-3.5",
  xs: "h-3 w-3",
} as const;

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ indeterminate = false, size = "sm", label, className, ...props }, ref) => {
    const inner = React.useRef<HTMLInputElement | null>(null);
    const attach = React.useCallback(
      (el: HTMLInputElement | null) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      },
      [ref],
    );
    React.useEffect(() => {
      if (inner.current) inner.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const input = (
      <input
        ref={attach}
        type="checkbox"
        className={cn(
          "shrink-0 cursor-pointer rounded accent-brand disabled:cursor-not-allowed disabled:opacity-50",
          fieldFocus(),
          SIZE[size],
          className,
        )}
        {...props}
      />
    );
    if (label === undefined) return input;
    return (
      <label className="flex cursor-pointer items-center gap-1.5 text-xs">
        {input}
        {label}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
