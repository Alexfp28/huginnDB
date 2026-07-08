import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      // Field labels default to `text-foreground` so forms read with real
      // label/value hierarchy. Previously this defaulted to
      // `text-muted-foreground`, which washed out every form in the app
      // (labels were the same grey as their own hint text). Hint-style copy
      // should use a `<p className="text-muted-foreground">`, not a `<Label>`;
      // a label that genuinely wants to recede can still pass the muted class.
      "text-xs font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
