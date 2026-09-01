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
 * **It owns the raw needle, its debounce, and the keys that read it —
 * everything except `ArrowDown`.** These used to live in `ConnectionsTree`,
 * which subscribed to `useTreeSearch`'s raw string to pass it down as a
 * `value` prop: that made every keystroke re-render the WHOLE tree (every
 * connection and its expanded subtree) before the debounce had done anything
 * at all, since the raw needle changes on every keystroke and `ConnectionsTree`
 * sat above it. Reading/writing `useTreeSearch` directly in here means a
 * keystroke only re-renders this box until the debounce commits — the tree
 * itself only re-renders once, on the committed `needle`/`patterns`/`scope`.
 * `ArrowDown` is the one exception: moving focus into the row list needs the
 * tree's own DOM (`moveRowFocus`), which this component has no business
 * knowing about, so it's still the caller's job via `onArrowDown`.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
} from "react";
import { Search, X } from "lucide-react";
import { DriverBadge } from "@/components/common/DriverBadge";
import { cn } from "@/lib/utils";
import {
  TREE_SEARCH_DEBOUNCE_MS,
  useTreeSearch,
} from "@/stores/session/treeSearch";
import type { Driver } from "@/types";

export const TreeFilterBox = forwardRef<
  HTMLInputElement,
  {
    /** Move focus into the row list — the one key this box can't handle on
     *  its own, since it has no visibility into the tree's DOM. */
    onArrowDown: () => void;
    placeholder: string;
    /** Clear-button tooltip. */
    clearLabel: string;
  }
>(function TreeFilterBox({ onArrowDown, placeholder, clearLabel }, ref) {
  const raw = useTreeSearch((s) => s.raw);
  const setRaw = useTreeSearch((s) => s.setRaw);
  const commitNeedle = useTreeSearch((s) => s.commit);
  const clearText = useTreeSearch((s) => s.clearText);
  const scopeKind = useTreeSearch((s) => s.scope.kind);
  const widenScopeOneLevel = useTreeSearch((s) => s.widen);
  const focusRequest = useTreeSearch((s) => s.focusRequest);

  const inputRef = useRef<HTMLInputElement>(null);
  // The DOM node itself is the imperative handle, so a caller holding `ref`
  // (ConnectionsTree's `moveRowFocus`, focusing this box on ArrowUp from the
  // first row) sees exactly the same element this component also reads from
  // internally below — one node, two consumers.
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  /**
   * The one debounce in the whole search path.
   *
   * It used to be per `MultiDbExplorer`, which is how the raw needle and the
   * debounced one could disagree for 250 ms about which databases to show
   * versus what to show inside them. With the string no longer travelling
   * down as a prop, only one committed needle exists at any instant and that
   * disagreement is unrepresentable.
   *
   * The empty case skips the wait, as it always has: clearing has to feel
   * immediate.
   */
  useEffect(() => {
    if (raw.trim().length === 0) {
      commitNeedle("");
      return;
    }
    const id = setTimeout(() => commitNeedle(), TREE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [raw, commitNeedle]);

  // A focus request (the keyboard shortcut, or a scope button that wants the
  // caret back) selects what is there, so typing replaces the previous needle.
  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Backspace on an empty box peels one level off the scope, the way it
    // removes the last chip in any tag input. Each press does something
    // visible, which is what makes the layering learnable.
    if (e.key === "Backspace" && raw.length === 0 && scopeKind !== "all") {
      e.preventDefault();
      widenScopeOneLevel();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onArrowDown();
      return;
    }
    if (e.key === "Enter") {
      // Commit now rather than waiting out the debounce. Deliberately NOT
      // "open the first match": with several connections searched at once
      // there is no single obvious first match, and guessing one is the
      // ambiguity this redesign exists to remove.
      e.preventDefault();
      commitNeedle();
    }
  }

  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1 overflow-hidden rounded-md border border-input bg-background px-1.5 transition-colors",
        // Same focus language as `inputVariants`: the border turns brand blue
        // with a soft 3px halo against it, rather than a detached ring.
        "focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/20",
      )}
    >
      <Search
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="text"
        className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground focus:outline-none"
        placeholder={placeholder}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {raw.length > 0 && (
        <button
          type="button"
          title={clearLabel}
          aria-label={clearLabel}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          onClick={clearText}
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
