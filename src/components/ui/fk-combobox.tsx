/**
 * Foreign-key combobox.
 *
 * Replaces the free-text input on draft-row cells (and cell edits) whose
 * column has a single-column FK constraint. Mirrors HeidiSQL: the user
 * picks a valid referenced value from a list instead of typing one.
 *
 * Behaviour:
 *
 *  - On mount, prefetches `PREFETCH_LIMIT` rows. Result is cached in
 *    `fkOptionsCache` so subsequent opens of the same target are instant.
 *  - When the target has more rows than the prefetch limit, the cache is
 *    flagged `too-large` and the combobox switches to server-side ILIKE
 *    search (debounced) on every keystroke.
 *  - The popover panel is a DOM descendant of the trigger so the parent
 *    row's `onBlur` commit logic correctly recognises focus as still
 *    being inside the row.
 *  - When the underlying column is nullable, a sticky `(NULL)` item is
 *    rendered at the top of the list.
 *  - If the prefetch fails (table dropped, FK pointing somewhere we can't
 *    read), the component renders a plain text input as a graceful
 *    fallback and surfaces the error via `console.warn`.
 */

import * as React from "react";
import { ChevronDown, X } from "lucide-react";
import { api } from "@/lib/tauri";
import {
  PREFETCH_LIMIT,
  TOO_LARGE,
  fkOptionsCache,
} from "@/stores/fkOptions";
import type { FkOption } from "@/types";
import { cn } from "@/lib/utils";

export interface FkComboboxProps {
  connectionId: string;
  refSchema?: string;
  refTable: string;
  refColumn: string;
  /** Current value (stringified). `null` means SQL NULL. */
  value: string | null;
  nullable: boolean;
  /** Disabled while the parent row is committing. */
  disabled?: boolean;
  /**
   * Called with the new value. `null` is emitted only when the user
   * explicitly picks the `(NULL)` item; the parent uses that to set
   * `touched: true` + `value: null`.
   */
  onChange: (value: string | null) => void;
  /**
   * Optional class for the trigger button — used to match the visual
   * weight of the surrounding cell input.
   */
  className?: string;
}

const SERVER_SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

export const FkCombobox = React.forwardRef<HTMLButtonElement, FkComboboxProps>(
  function FkCombobox(
    {
      connectionId,
      refSchema,
      refTable,
      refColumn,
      value,
      nullable,
      disabled,
      onChange,
      className,
    },
    ref,
  ) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const [prefetched, setPrefetched] = React.useState<FkOption[] | null>(null);
    const [tooLarge, setTooLarge] = React.useState(false);
    const [searchResults, setSearchResults] = React.useState<FkOption[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [fetchError, setFetchError] = React.useState<string | null>(null);

    const rootRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    React.useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);

    // Initial prefetch (cache-first).
    React.useEffect(() => {
      const cached = fkOptionsCache.get(
        connectionId,
        refSchema,
        refTable,
        refColumn,
      );
      if (cached) {
        // The cached page is shown as a preview even when the target is
        // too large; the user still gets a sense of what's there without
        // having to type a query first.
        setPrefetched(cached.options);
        setTooLarge(cached.kind === TOO_LARGE);
        return;
      }
      let cancelled = false;
      setLoading(true);
      api
        .fetchFkOptions({
          connectionId,
          schema: refSchema,
          table: refTable,
          keyColumn: refColumn,
          limit: PREFETCH_LIMIT,
        })
        .then((page) => {
          if (cancelled) return;
          // Always keep the first page around as a preview. `has_more`
          // only changes whether typing triggers a server-side query —
          // it does not hide the rows we already paid for.
          fkOptionsCache.set(connectionId, refSchema, refTable, refColumn, {
            kind: page.has_more ? TOO_LARGE : "ready",
            options: page.options,
          });
          setPrefetched(page.options);
          setTooLarge(page.has_more);
        })
        .catch((err) => {
          if (cancelled) return;
          const message = String(err);
          console.warn(
            `FkCombobox: prefetch failed for ${refSchema ?? ""}.${refTable}.${refColumn}: ${message}`,
          );
          setFetchError(message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [connectionId, refSchema, refTable, refColumn]);

    // Server-side search when the cache is `too-large`.
    React.useEffect(() => {
      if (!open || !tooLarge) return;
      const term = query.trim();
      if (!term) {
        setSearchResults([]);
        return;
      }
      const handle = setTimeout(() => {
        setLoading(true);
        api
          .fetchFkOptions({
            connectionId,
            schema: refSchema,
            table: refTable,
            keyColumn: refColumn,
            search: term,
            limit: SERVER_SEARCH_LIMIT,
          })
          .then((page) => setSearchResults(page.options))
          .catch((err) => {
            console.warn(`FkCombobox: search failed: ${String(err)}`);
            setSearchResults([]);
          })
          .finally(() => setLoading(false));
      }, SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(handle);
    }, [open, tooLarge, query, connectionId, refSchema, refTable, refColumn]);

    // Click-outside close. The listener stays inside the root subtree, so
    // clicking the panel itself never closes; only outside clicks do.
    React.useEffect(() => {
      if (!open) return;
      function onDown(e: MouseEvent) {
        if (!rootRef.current) return;
        if (!rootRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      }
      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    const visible: FkOption[] = React.useMemo(() => {
      const term = query.trim().toLowerCase();
      // Too-large + query: server-side ILIKE results win, because the
      // prefetched preview is just the first 200 rows and almost
      // certainly misses what the user is searching for.
      if (tooLarge && term) return searchResults;
      if (!prefetched) return [];
      if (!term) return prefetched;
      return prefetched.filter((opt) => {
        if (opt.value.toLowerCase().includes(term)) return true;
        if (opt.label && opt.label.toLowerCase().includes(term)) return true;
        return false;
      });
    }, [tooLarge, searchResults, prefetched, query]);

    // Fallback: backend errored on prefetch. Degrade to plain text input.
    if (fetchError) {
      return (
        <input
          className={cn(
            "h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring",
            className,
          )}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          title={`FK lookup unavailable: ${fetchError}`}
        />
      );
    }

    const triggerLabel = renderTriggerLabel(value, prefetched, searchResults);

    return (
      <div ref={rootRef} className="relative w-full">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            // Open on Enter/Down so keyboard users can reach the panel
            // without a mouse click.
            if (!open && (e.key === "Enter" || e.key === "ArrowDown")) {
              e.preventDefault();
              setOpen(true);
            } else if (open && e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          className={cn(
            "flex h-6 w-full min-w-0 items-center justify-between gap-1 rounded-sm border border-input bg-background px-1.5 font-mono text-xs",
            "focus:outline-none focus:ring-1 focus:ring-ring",
            value === null
              ? "italic text-muted-foreground"
              : "text-foreground",
            className,
          )}
        >
          <span className="truncate text-left" title={triggerLabel.tooltip}>
            {triggerLabel.text}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        {open && (
          <div
            className="absolute left-0 top-full z-50 mt-1 w-[min(20rem,max(100%,12rem))] rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            // Catch mousedown so clicks on the panel chrome (search bar
            // padding, scrollbar) don't bubble up and trigger the parent
            // row's blur-commit before the click registers.
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-1 border-b border-border/60 p-1">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }
                }}
                placeholder={
                  tooLarge
                    ? `Search ${refTable}…`
                    : `Filter ${refTable}…`
                }
                className="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {tooLarge && !query.trim() && (
                <div className="px-1 text-[10px] italic text-muted-foreground">
                  Showing first {prefetched?.length ?? 0} rows · type to
                  search all
                </div>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {nullable && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs italic text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <X className="h-3 w-3 opacity-60" />
                  (NULL)
                </button>
              )}
              {loading && visible.length === 0 && (
                <div className="px-2 py-1 text-xs italic text-muted-foreground">
                  Loading…
                </div>
              )}
              {!loading && visible.length === 0 && (
                <div className="px-2 py-1 text-xs italic text-muted-foreground">
                  No matches
                </div>
              )}
              {visible.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground",
                    opt.value === value && "bg-accent/60",
                  )}
                  title={
                    opt.label ? `${opt.value} — ${opt.label}` : opt.value
                  }
                >
                  <span className="shrink-0">{opt.value}</span>
                  {opt.label && (
                    <span className="truncate text-muted-foreground">
                      — {opt.label}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  },
);

/**
 * Compute what the trigger button should display, given the current value
 * and whatever option lists we have lying around. We look up the label so
 * users see e.g. "5 — Jazz" rather than just "5" when the value is known.
 */
function renderTriggerLabel(
  value: string | null,
  prefetched: FkOption[] | null,
  searchResults: FkOption[],
): { text: string; tooltip: string } {
  if (value === null) return { text: "NULL", tooltip: "SQL NULL" };
  const all = [...(prefetched ?? []), ...searchResults];
  const hit = all.find((o) => o.value === value);
  if (hit && hit.label) {
    const text = `${hit.value} — ${hit.label}`;
    return { text, tooltip: text };
  }
  return { text: value, tooltip: value };
}
