import * as React from "react";
import { cn } from "@/lib/utils";

// Shared multiline input. Mirrors the Input primitive's border/focus language
// so textareas stop being hand-rolled per dialog (FeedbackDialog previously
// duplicated the class string; SaveQueryDialog misused a single-line Input for
// a description). Height is left to the caller via `rows`/`className`.
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
