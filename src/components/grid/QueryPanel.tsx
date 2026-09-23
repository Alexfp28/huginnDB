/**
 * The table browse's **query panel**: an inline section under the grid
 * toolbar, opened from its "Query" button, that edits what the browse asks the
 * server for.
 *
 * It replaces `AdvancedFilterDialog`, and for now it holds exactly what that
 * dialog held — the flat AND list of column → operator → value conditions.
 * It is a panel rather than a modal because it is meant to grow into the rest
 * of the query (projection, a raw filter, the query it produces) without
 * turning into a stack of dialogs, and because a modal hides the rows you are
 * filtering: here the page stays on screen under the conditions that shape it.
 * Keeping both would have meant two places editing the same `serverFilters`,
 * which is the one thing this surface must not have.
 *
 * **It is a bijection with `serverFilters`, as the dialog was.** Every filter
 * shape has a control in `FilterConditionRow`, so the panel edits the whole
 * array, in order, and a toolbar chip's index names the row seeded from it —
 * that is all `focusIndex` is. Hold a filter shape aside again and chip-editing
 * silently edits the wrong row.
 *
 * ## The draft and the applied filters
 *
 * The rows are a draft: nothing reaches the server until **Apply** (or
 * Ctrl/⌘+Enter). The applied filters also change from outside while the panel
 * is open — a chip's ✕, a right-click "Filter by this value" — and the rule for
 * that is the one that loses nothing the user can see:
 *
 * - an **untouched** draft follows the applied filters, so the panel always
 *   shows what is in force;
 * - a **touched** draft is kept, and says it has unapplied changes. It is on
 *   screen, so the user can see both it and the chips it would replace.
 *
 * Closing the panel discards a touched draft, the way cancelling the dialog
 * did. A draft that outlives the panel showing it would be applied later by
 * someone who no longer remembers typing it.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { filterFieldsFor, type FilterField } from "@/lib/grid/fieldPaths";
import { formatForDisplay } from "@/lib/keybindings/chord";
import type { ColumnFilter, ColumnInfo } from "@/types";
import { FilterConditionRow } from "@/components/grid/dialogs/FilterConditionRow";
import {
  draftFromFilter,
  emptyDraft,
  filterFromDraft,
  overlongListRows,
  patchDraft,
  type FilterConditionDraft,
} from "@/components/grid/dialogs/filterConditions";

let nextKey = 1;

/** Rows seeded from `applied`, plus which row came from which filter — the
 *  map a chip's index is resolved through. */
function seed(applied: ColumnFilter[]): {
  rows: FilterConditionDraft[];
  seeded: number[];
} {
  const rows = applied.map((f) => draftFromFilter(f, nextKey++));
  return { rows, seeded: rows.map((r) => r.key) };
}

/**
 * "Open the panel on this chip's row", as an event rather than a state: the
 * same chip clicked twice has to scroll and focus twice, which a plain index
 * would not (it would be equal the second time). Same reasoning as the list
 * view's `ExpandAllSignal`.
 */
export interface QueryPanelFocus {
  index: number;
  epoch: number;
}

export function QueryPanel({
  columns,
  nestedFields,
  customFields,
  applied,
  focus,
  onApply,
  onClose,
}: {
  columns: ColumnInfo[];
  /** Nested paths found in the page on screen (MongoDB) — see
   *  `lib/grid/fieldPaths.ts`. */
  nestedFields?: FilterField[];
  /** A field outside the lists may be typed (MongoDB). */
  customFields?: boolean;
  /** The filters in force — `serverFilters`. */
  applied: ColumnFilter[];
  /** The chip the user clicked to get here, if they did. */
  focus: QueryPanelFocus | null;
  onApply: (filters: ColumnFilter[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState(() => seed(applied));
  const [touched, setTouched] = useState(false);

  // Follow the applied filters while the draft is untouched — see the module
  // header. React's "adjust state when a prop changes" pattern, set during
  // render and tracked in state (not a ref) so StrictMode's discarded first
  // pass cannot swallow the update; `DocumentCard` documents that trap.
  const [seenApplied, setSeenApplied] = useState(applied);
  if (seenApplied !== applied) {
    setSeenApplied(applied);
    if (!touched) setDraft(seed(applied));
  }

  const [focusedKey, setFocusedKey] = useState<number | null>(null);
  const [seenFocus, setSeenFocus] = useState<QueryPanelFocus | null>(null);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    setFocusedKey(focus ? (draft.seeded[focus.index] ?? null) : null);
  }

  const focusedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedKey == null) return;
    const el = focusedRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.querySelector<HTMLElement>("input, textarea, button")?.focus();
    // `focus` in the deps: the same row asked for twice is focused twice.
  }, [focusedKey, focus]);

  const fields = useMemo(
    () => filterFieldsFor(columns, nestedFields ?? []),
    [columns, nestedFields],
  );
  const typeByColumn = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of fields) if (f.type) m.set(f.path, f.type);
    return m;
  }, [fields]);

  const rows = draft.rows;
  /** Rows whose value list is over the backend's cap — Apply is blocked while
   *  any exists, rather than truncating or letting the call fail. */
  const overlong = useMemo(() => overlongListRows(rows), [rows]);

  function edit(next: (prev: FilterConditionDraft[]) => FilterConditionDraft[]) {
    setDraft((prev) => ({ ...prev, rows: next(prev.rows) }));
    setTouched(true);
  }

  const addRow = () =>
    edit((prev) => [...prev, emptyDraft(fields[0]?.path ?? "", nextKey++)]);
  const removeRow = (key: number) =>
    edit((prev) => prev.filter((r) => r.key !== key));
  const patchRow = (key: number, patch: Partial<FilterConditionDraft>) =>
    edit((prev) => prev.map((r) => (r.key === key ? patchDraft(r, patch) : r)));

  function apply() {
    if (overlong.size > 0) return;
    const filters = rows
      .filter((r) => r.column)
      .map((r) => filterFromDraft(r, typeByColumn.get(r.column)));
    onApply(filters);
    // The applied filters are about to become exactly this draft; re-seeding
    // from them (below, when the new array arrives) keeps the chip → row map
    // honest, and an untouched draft is what lets that happen.
    setTouched(false);
    setFocusedKey(null);
  }

  function reset() {
    setDraft(seed(applied));
    setTouched(false);
    setFocusedKey(null);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      apply();
    }
  }

  return (
    <section
      aria-label={t("tableData.query.title")}
      className="flex max-h-[45vh] shrink-0 flex-col border-b border-border bg-muted/20 text-xs"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto px-3 pb-2 pt-2.5">
        <div className="w-24 shrink-0 pt-1.5">
          <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("tableData.query.filter")}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="pt-1 text-2xs text-muted-foreground">
            {t("tableData.query.matchAll")}
          </p>
          {rows.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t("tableData.filter.empty")}
            </p>
          ) : (
            rows.map((r) => (
              <FilterConditionRow
                key={r.key}
                ref={r.key === focusedKey ? focusedRef : undefined}
                highlighted={r.key === focusedKey}
                fields={fields}
                customFields={customFields}
                row={r}
                onPatch={(patch) => patchRow(r.key, patch)}
                onRemove={() => removeRow(r.key)}
              />
            ))
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            icon={Plus}
            // A field list that came back empty still leaves a condition
            // writable when the path can be typed — the MongoDB case.
            disabled={fields.length === 0 && !customFields}
            onClick={addRow}
          >
            {t("tableData.filter.addRow")}
          </Button>
        </div>
        <IconButton
          icon={X}
          label={t("tableData.query.close")}
          className="-mr-1 shrink-0"
          onClick={onClose}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={rows.length === 0}
          onClick={() => edit(() => [])}
        >
          {t("tableData.filter.clearAll")}
        </Button>
        {touched && (
          <span className="text-2xs text-warning">
            {t("tableData.query.unapplied")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!touched}
            onClick={reset}
          >
            {t("tableData.query.reset")}
          </Button>
          {/* The shortcut sits beside the button, never inside it: a key cap
              is drawn on the neutral surfaces (`bg-muted`), and on a
              primary-filled button that box reads as a dark patch stuck on
              top of the theme's colour. A local key handler rather than a
              catalogue action: it only ever means "apply this panel", and
              only while focus is in it. */}
          <span className="text-2xs text-muted-foreground" aria-hidden>
            <Kbd>{formatForDisplay("Mod+Enter")}</Kbd>
          </span>
          <Button
            type="button"
            size="xs"
            disabled={overlong.size > 0}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={apply}
          >
            {t("tableData.filter.apply")}
          </Button>
        </div>
      </div>
    </section>
  );
}
