import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { fieldFocus } from "@/components/ui/styles";

/**
 * The OS's own `<select>`, themed.
 *
 * Distinct from `ui/select.tsx` (Radix) on purpose, and both are right for
 * their job: Radix gives a portalled, fully styleable listbox and is what a
 * form wants, but it is fixed at `h-9` and a portalled popup is worse UX than
 * the OS's own inside a table cell or a dense toolbar. Thirteen selects in the
 * app are that second kind.
 *
 * **`bg-background text-foreground` are in the base, never in a variant, and
 * must never become `bg-transparent`.** WebView2/Chromium paints its native
 * dropdown popup using the trigger element's own `background-color` and
 * `color`, so a transparent trigger left the open popup falling back to the OS
 * light-theme default regardless of the app's theme — a dark-theme-only bug,
 * visible only while the popup is open. Six call sites each carried their own
 * copy of this fix, in four different spellings of the surrounding chrome; this
 * is the one place it needs to live, and the reason the fourteenth select will
 * be born correct.
 */
const nativeSelectVariants = cva(
  [
    // No `w-full` and no `appearance-none`: half these selects sit in a toolbar
    // and size to their content, and removing the native arrow would leave a
    // dropdown with no affordance at all — the whole point of using the OS
    // control here is that it looks and behaves like one.
    "cursor-pointer rounded-md border border-input bg-background text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    fieldFocus(),
  ],
  {
    variants: {
      // The shared xs/sm/md vocabulary — see `README.md`.
      size: {
        md: "h-9 px-3 text-sm",
        sm: "h-8 px-2.5 text-xs",
        xs: "h-7 px-2 text-xs",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: { size: "md", mono: false },
  },
);

export interface NativeSelectProps
  extends
    Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">,
    VariantProps<typeof nativeSelectVariants> {}

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  NativeSelectProps
>(({ className, size, mono, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(nativeSelectVariants({ size, mono, className }))}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";

export { nativeSelectVariants };
