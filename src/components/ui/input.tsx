import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { fieldFocus } from "@/components/ui/styles";

// Density variants for this dense desktop tool. The default `h-9` shadcn input
// was too tall for most surfaces, so nearly every call site was hand-patching
// `h-6`/`h-7`/`text-xs`. `sm`/`xs` tokenise that instead. The native HTML
// `size` attribute (character width) is omitted below so it doesn't collide
// with this cva `size` variant — it's effectively never used in the app.
// Focus language (shared with Textarea and Select): the border itself turns
// brand blue and a soft 3px halo sits directly against it. The previous
// `ring-2 + ring-offset-2` drew a detached blue outline with a background-
// coloured gap — legible, but a heavy, floating ring on a 28px-tall field, and
// the brief asks inputs to stay very clean with a fine border and a blue focus.
const inputVariants = cva(
  [
    "flex w-full rounded-md border border-input bg-background transition-colors file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground",
    fieldFocus(),
    "disabled:cursor-not-allowed disabled:opacity-50",
  ],
  {
    variants: {
      size: {
        md: "h-9 px-3 py-1 text-sm file:text-sm",
        sm: "h-8 px-2.5 py-1 text-xs file:text-xs",
        xs: "h-7 px-2 py-0.5 text-xs file:text-xs",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface InputProps
  extends
    Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, ...props }, ref) => (
    <input
      type={type}
      className={cn(inputVariants({ size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input, inputVariants };
