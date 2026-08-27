/**
 * The Schema panel's search control.
 *
 * Composed by hand rather than reusing `<Input>` with an absolutely-positioned
 * magnifier, following `GridSearchInput`'s structure — a flex row of
 * fixed-width affordances around a bare `<input>`, all inside one 28px bordered
 * box. The focus classes are copied verbatim from `inputVariants`
 * (`components/ui/input.tsx`) so this box and every real `<Input>` in the app
 * cannot drift apart visually.
 *
 * **The scope chip is deliberately NOT in here.** It was, briefly, in front of
 * the caret — and in the panel width people actually use (this thing gets
 * docked left at just enough for the tree) a chip reading
 * "Dev | Tencer | MySQL · iMesPyme" left about eight characters of input
 * visible. The flex maths made it worse than it had to be: the input carries
 * `flex-1 min-w-0`, so it is the first thing to shrink and the chip won the
 * space outright. Rather than fight that with minimum widths and an
 * ever-shorter label, the chip moved out to the status line below
 * (`ConnectionsTree`), where it can say the whole scope without competing with
 * the thing you are typing into.
 *
 * Its ✕ therefore clears the *text* only; the chip has its own for the scope.
 * Each control clears what it sits next to.
 *
 * It owns no search state. The needle, its debounce and the scope live in
 * `useTreeSearch`; this is the widget that shows the needle.
 */

import { forwardRef, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { DriverBadge } from "@/components/common/DriverBadge";
import { cn } from "@/lib/utils";
import type { Driver } from "@/types";

export const TreeFilterBox = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    /** Clears the text. The scope is the chip's business — see the header. */
    onClear: () => void;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
    placeholder: string;
    /** Clear-button tooltip. */
    clearLabel: string;
  }
>(function TreeFilterBox(
  { value, onChange, onClear, onKeyDown, placeholder, clearLabel },
  ref,
) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1 overflow-hidden rounded-md border border-input bg-background px-1.5 transition-colors",
        // Same focus language as `inputVariants`: the border turns brand blue
        // with a soft 3px halo against it, rather than a detached ring.
        "focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/20",
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <input
        ref={ref}
        type="text"
        className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground focus:outline-none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {value.length > 0 && (
        <button
          type="button"
          title={clearLabel}
          aria-label={clearLabel}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent/40 hover:text-foreground"
          onClick={onClear}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

/**
 * "This search is narrowed to here", on the status line under the box.
 *
 * It follows `ServerFilterChip`'s vocabulary — a pill, a value, a ✕ that
 * removes it — and carries the connection's `DriverBadge` because on a screen
 * with a MySQL, a MongoDB and a sandbox open the driver mark identifies a
 * connection faster than its truncated name does.
 *
 * It lives here rather than in the box because it needs room to name a
 * connection *and* a database, and the box needs room to be typed into; see
 * `TreeFilterBox`'s header. On the status line it shares a wrapping flex row
 * with the match summary, so on a narrow panel it takes the line it needs
 * instead of taking it from the input.
 *
 * Its ✕ drops the scope and keeps the needle — widening a search is the common
 * next move, and the box's ✕ is right above it for the other direction.
 */
export function ScopeChip({
  driver,
  label,
  title,
  onClear,
  clearLabel,
}: {
  driver: Driver | undefined;
  label: string;
  title: string;
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <span
      title={title}
      className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-1.5 py-px text-[10px] text-brand"
    >
      {driver && <DriverBadge driver={driver} />}
      <span className="truncate">{label}</span>
      <button
        type="button"
        title={clearLabel}
        aria-label={clearLabel}
        className="shrink-0 text-brand/70 transition-colors hover:text-brand"
        onClick={onClear}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
