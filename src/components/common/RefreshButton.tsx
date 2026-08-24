/**
 * The icon-only "reload this panel" button, five copies of which had drifted
 * into three spellings of the same thing (`cn("h-3.5 w-3.5", loading &&
 * "animate-spin")`, a ternary, and a template string) while rendering
 * identically.
 *
 * `loading` spins the icon *and* disables the button, because those always went
 * together: a second click during a refresh only queues a duplicate fetch.
 */

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RefreshButton({
  onClick,
  loading = false,
  title,
  disabled = false,
  className,
}: {
  onClick: () => void;
  /** Spins the icon and disables the button. */
  loading?: boolean;
  /** Tooltip — the only text an icon-only button gets, so never omit it. */
  title: string;
  /** Disable for a reason other than a refresh being in flight. */
  disabled?: boolean;
  /** Extra classes on the button (the editor tabs use a denser `h-7 w-7`). */
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={onClick}
      disabled={loading || disabled}
      title={title}
    >
      <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
    </Button>
  );
}
