/**
 * Reusable row layout for a single preference: label + description on the
 * left, control on the right. All settings sections compose these.
 */

import { Label } from "@/components/ui/label";

interface Props {
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
}

export function PrefRow({ label, description, htmlFor, children }: Props) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && (
          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
