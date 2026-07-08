import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Density variants for this dense desktop tool. The default `h-9` shadcn input
// was too tall for most surfaces, so nearly every call site was hand-patching
// `h-6`/`h-7`/`text-xs`. `sm`/`xs` tokenise that instead. The native HTML
// `size` attribute (character width) is omitted below so it doesn't collide
// with this cva `size` variant — it's effectively never used in the app.
const inputVariants = cva(
  "flex w-full rounded-md border border-input bg-background transition-colors file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      inputSize: {
        default: "h-9 px-3 py-1 text-sm file:text-sm",
        sm: "h-8 px-2.5 py-1 text-xs file:text-xs",
        xs: "h-7 px-2 py-0.5 text-xs file:text-xs",
      },
    },
    defaultVariants: {
      inputSize: "default",
    },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, inputSize, ...props }, ref) => (
    <input
      type={type}
      className={cn(inputVariants({ inputSize, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input, inputVariants };
