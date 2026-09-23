/**
 * The table browse's **query panel**: an inline section under the grid
 * toolbar, opened from its "Query" button, that edits what the browse asks the
 * server for.
 *
 * It replaced `AdvancedFilterDialog` and holds two rows: the flat AND list of
 * column → operator → value conditions the dialog held, and the projection
 * (which fields the browse returns — see `lib/grid/projection.ts` for how the
 * key columns are added on the way to the wire).
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
 * Both rows are one draft: nothing reaches the server until **Apply** (or
 * Ctrl/⌘+Enter), which applies the conditions and the projection together.
 * The applied state also changes from outside while the panel
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
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Lock, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { filterFieldsFor, type FilterField } from "@/lib/grid/fieldPaths";
import { DOCUMENT_ID, isLockedField } from "@/lib/grid/projection";
import { formatForDisplay } from "@/lib/keybindings/chord";
import type { ColumnFilter, ColumnInfo, Projection } from "@/types";
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

/** The projection row's draft. `all` is "no projection"; the other two keep
 *  their field list so switching modes does not throw the picks away. */
type ProjectionMode = "all" | "include" | "exclude";
interface ProjectionDraft {
  mode: ProjectionMode;
  fields: string[];
}

function seedProjection(p: Projection | undefined): ProjectionDraft {
  if (!p || p.fields.length === 0) return { mode: "all", fields: [] };
  return { mode: p.exclude ? "exclude" : "include", fields: [...p.fields] };
}

function projectionFromDraft(d: ProjectionDraft): Projection | undefined {
  if (d.mode === "all" || d.fields.length === 0) return undefined;
  return { fields: d.fields, exclude: d.mode === "exclude" };
}

/** What the panel applies: the conditions and the projection, together. */
export interface QueryPanelApply {
  filters: ColumnFilter[];
  projection: Projection | undefined;
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
  appliedProjection,
  document = false,
  keyColumns = NO_KEYS,
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
  /** The projection in force, as the user chose it (no key columns added). */
  appliedProjection?: Projection;
  /** MongoDB: the projection can exclude, and `_id` is the locked key. */
  document?: boolean;
  /** SQL: the primary key's columns, shown locked in the projection. */
  keyColumns?: readonly string[];
  /** The chip the user clicked to get here, if they did. */
  focus: QueryPanelFocus | null;
  onApply: (next: QueryPanelApply) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState(() => seed(applied));
  const [projection, setProjection] = useState(() =>
    seedProjection(appliedProjection),
  );
  const [touched, setTouched] = useState(false);

  // Follow the applied state while the draft is untouched — see the module
  // header. React's "adjust state when a prop changes" pattern, set during
  // render and tracked in state (not a ref) so StrictMode's discarded first
  // pass cannot swallow the update; `DocumentCard` documents that trap.
  const [seenApplied, setSeenApplied] = useState(applied);
  const [seenProjection, setSeenProjection] = useState(appliedProjection);
  if (seenApplied !== applied || seenProjection !== appliedProjection) {
    setSeenApplied(applied);
    setSeenProjection(appliedProjection);
    if (!touched) {
      setDraft(seed(applied));
      setProjection(seedProjection(appliedProjection));
    }
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

  function editProjection(next: ProjectionDraft) {
    setProjection(next);
    setTouched(true);
  }

  function apply() {
    if (overlong.size > 0) return;
    const filters = rows
      .filter((r) => r.column)
      .map((r) => filterFromDraft(r, typeByColumn.get(r.column)));
    onApply({ filters, projection: projectionFromDraft(projection) });
    // The applied filters are about to become exactly this draft; re-seeding
    // from them (below, when the new array arrives) keeps the chip → row map
    // honest, and an untouched draft is what lets that happen.
    setTouched(false);
    setFocusedKey(null);
  }

  function reset() {
    setDraft(seed(applied));
    setProjection(seedProjection(appliedProjection));
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
      <div className="relative min-h-0 flex-1 overflow-auto px-3 pb-2 pt-2.5">
        <IconButton
          icon={X}
          label={t("tableData.query.close")}
          className="absolute right-2 top-1.5"
          onClick={onClose}
        />
        <div className="space-y-3 pr-8">
          <PanelRow label={t("tableData.query.filter")}>
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
          </PanelRow>
          <PanelRow
            label={
              document
                ? t("tableData.query.projection")
                : t("tableData.query.columns")
            }
          >
            <ProjectionEditor
              value={projection}
              onChange={editProjection}
              choices={fields}
              document={document}
              keyColumns={keyColumns}
            />
          </PanelRow>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={rows.length === 0 && projection.mode === "all"}
          onClick={() => {
            edit(() => []);
            editProjection({ mode: "all", fields: [] });
          }}
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

const NO_KEYS: readonly string[] = [];

/** One labelled row of the panel: the label gutter, then its controls. */
function PanelRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-24 shrink-0 pt-1.5">
        <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Two paths MongoDB refuses in one projection: the same one twice, or one
 *  inside the other (`meta` with `meta.plant` is a "path collision"). */
function collides(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * The projection row: which fields come back.
 *
 * The key is drawn **locked**, first, and is never in the pick list — the
 * primary key's columns on SQL, `_id` on MongoDB. The browse adds it on the
 * way to the wire whatever the user picks (`wireProjection`), because every
 * edit addresses a row by it. Showing it as picked-and-removable would offer
 * a choice that cannot be made.
 */
function ProjectionEditor({
  value,
  onChange,
  choices,
  document,
  keyColumns,
}: {
  value: ProjectionDraft;
  onChange: (next: ProjectionDraft) => void;
  choices: FilterField[];
  document: boolean;
  keyColumns: readonly string[];
}) {
  const { t } = useTranslation();
  const exclude = value.mode === "exclude";
  const lockOpts = { document, keyColumns, exclude };

  const locked =
    value.mode === "include" ? (document ? [DOCUMENT_ID] : [...keyColumns]) : [];
  const pickable = choices
    .map((c) => c.path)
    .filter(
      (path) =>
        !isLockedField(path, lockOpts) &&
        !value.fields.some((f) => collides(f, path)),
    );

  const modes = document
    ? [
        { value: "all" as const, label: t("tableData.query.projAllFields") },
        { value: "include" as const, label: t("tableData.query.projInclude") },
        { value: "exclude" as const, label: t("tableData.query.projExclude") },
      ]
    : [
        { value: "all" as const, label: t("tableData.query.projAll") },
        { value: "include" as const, label: t("tableData.query.projPick") },
      ];

  const hint =
    value.mode === "all"
      ? null
      : exclude
        ? t("tableData.query.idNotExcludable")
        : document
          ? t("tableData.query.idLocked")
          : keyColumns.length > 0
            ? t("tableData.query.keyLocked")
            : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented<ProjectionMode>
          size="sm"
          aria-label={t("tableData.query.projectionMode")}
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode })}
          options={modes}
        />
        {value.mode !== "all" && (
          <>
            {locked.map((f) => (
              <span
                key={`locked-${f}`}
                className="flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 font-mono text-2xs text-muted-foreground"
              >
                {document ? (
                  <Lock className="h-3 w-3" />
                ) : (
                  <KeyRound className="h-3 w-3 text-pk" />
                )}
                {f}
              </span>
            ))}
            {value.fields
              .filter((f) => !isLockedField(f, lockOpts))
              .map((f) => (
                <span
                  key={f}
                  className="flex h-6 items-center gap-0.5 rounded-md border border-border bg-background pl-2 font-mono text-2xs"
                >
                  {f}
                  <IconButton
                    size="xs"
                    icon={X}
                    label={t("tableData.query.removeField", { field: f })}
                    onClick={() =>
                      onChange({
                        ...value,
                        fields: value.fields.filter((x) => x !== f),
                      })
                    }
                  />
                </span>
              ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="xs" icon={Plus}>
                  {document
                    ? t("tableData.query.addField")
                    : t("tableData.query.addColumn")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[22rem]">
                {pickable.length === 0 ? (
                  <DropdownMenuItem className="text-xs" disabled>
                    {t("tableData.query.noMoreFields")}
                  </DropdownMenuItem>
                ) : (
                  pickable.map((path) => (
                    <DropdownMenuItem
                      key={path}
                      className="font-mono text-xs"
                      onSelect={() =>
                        onChange({ ...value, fields: [...value.fields, path] })
                      }
                    >
                      {path}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
      {value.mode !== "all" && value.fields.length === 0 && (
        <p className="text-2xs text-muted-foreground">
          {t("tableData.query.pickHint")}
        </p>
      )}
    </>
  );
}
