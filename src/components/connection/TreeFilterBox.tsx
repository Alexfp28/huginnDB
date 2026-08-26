/**
 * The Schema panel's search control.
 *
 * Composed by hand rather than reusing `<Input>` with an absolutely-positioned
 * magnifier because the scope chip has to *push* the text: an `absolute` icon
 * overlays whatever is under it, and a chip that overlays the caret is worse
 * than no chip. The structure is `GridSearchInput`'s — a flex row of
 * fixed-width affordances around a bare `<input>`, all inside one 28px
 * bordered box — and the focus classes are copied verbatim from `inputVariants`
 * (`components/ui/input.tsx`) so this box and every real `<Input>` in the app
 * cannot drift apart visually.
 *
 * It owns no search state. The needle, its debounce and the scope live in
 * `useTreeSearch`; this is the widget that shows them.
 */

import { forwardRef, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { DriverBadge } from "@/components/common/DriverBadge";
import { cn } from "@/lib/utils";
import type { Driver } from "@/types";

export const TreeFilterBox = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    /** Clears the text *and* the scope — see `useTreeSearch.clear`. */
    onClear: () => void;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
    placeholder: string;
    /** Clear-button tooltip. */
    clearLabel: string;
    /** The scope chip, when the search is narrowed to one connection/database. */
    chip?: ReactNode;
  }
>(function TreeFilterBox(
  { value, onChange, onClear, onKeyDown, placeholder, clearLabel, chip },
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
      {chip}
      <input
        ref={ref}
        type="text"
        className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground focus:outline-none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {(value.length > 0 || chip) && (
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
 * "This search is narrowed to here", inside the box and in front of the caret.
 *
 * It follows `ServerFilterChip`'s vocabulary (a pill, a value, a ✕ that
 * removes it) shrunk to fit a 28px field, and carries the connection's
 * `DriverBadge` because on a screen with a MySQL, a MongoDB and a sandbox open
 * the driver mark identifies a connection faster than its truncated name does.
 *
 * Its ✕ drops the scope and keeps the needle — widening a search is the common
 * next move. The box's own ✕ is the one that clears both.
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
      className="flex min-w-0 shrink items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-1.5 py-px text-[10px] text-brand"
    >
      {driver && <DriverBadge driver={driver} />}
      <span className="max-w-[8rem] truncate">{label}</span>
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
