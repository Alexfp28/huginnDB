/**
 * The data grid's **list view**: one card per row, one `key : value` line per
 * field, MongoDB-Compass style.
 *
 * Why it exists: a wide or deeply nested row (a MongoDB document, but equally a
 * 40-column SQL table or a JSONB blob) is unreadable in a table — it scrolls
 * horizontally and every nested value collapses into a single unreadable JSON
 * line. Here each field gets its own line, nested objects/arrays fold, and the
 * type of every field is visible in the right gutter.
 *
 * It is an *editor*, not just a viewer:
 *
 * - double-click a value → inline edit, committed on Enter/blur (the same
 *   immediate per-field commit the table view uses, through the same
 *   `update_cell` command);
 * - the expand button escalates to the heavyweight Monaco editor, exactly as
 *   the table's inline editor does — that is how a whole sub-document is
 *   edited as JSON;
 * - on MongoDB only, the type gutter is a picker (rewriting the field with the
 *   chosen BSON type), fields can be added (`$set` on a new path) and removed
 *   (`$unset`, behind the destructive-action confirmation). SQL rows have a
 *   fixed column set, so those three affordances are hidden there — a column is
 *   not a per-row thing.
 * - a whole new row/document is inserted here too, as a draft card pinned above
 *   the documents (`DraftDocumentCard`) — the same draft state and the same
 *   `insert_row` call the table view's pinned draft row uses, so view mode
 *   changes how the draft is drawn and nothing about what it writes.
 *
 * Two structural notes:
 *
 * - Every mutation addresses its field by **path**, never by a display index —
 *   the list is filtered/sorted client-side just like the table (CLAUDE.md
 *   gotcha #7), and a nested field has no index to speak of.
 * - Per-card state (folds, the field being edited, the draft field) lives in
 *   `DocumentCard`, so editing one document never re-renders the others. Cards
 *   are keyed by position, which is what makes folds survive the refetch that
 *   follows every commit.
 */

import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { notify } from "@/lib/notify";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Inbox,
  Maximize2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DraftCellControl,
  firstEditableColumn,
  isAutoPkColumn,
} from "@/components/grid/DraftCellControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { toJson as rowToJson } from "@/lib/grid/copyFormats";
import {
  BSON_TYPES,
  defaultText,
  displayValue,
  draftTypeFor,
  editText,
  flattenDocument,
  isValidForType,
  nextArrayIndex,
  pathKey,
  typeLabel,
  typeTextFor,
  typeValue,
  type BsonType,
  type DocField,
} from "@/lib/grid/documentTree";
import { cn } from "@/lib/utils";
import type {
  BsonTypeTree,
  CellValue,
  ColumnInfo,
  ColumnMeta,
  DraftCell,
  DraftRow,
} from "@/types";

/** Commit one field. `path` is the field path from the document root, `value`
 *  the text the editor produced (`null` for SQL NULL / BSON null), `typeHint`
 *  the type it should be written as. */
export type FieldSave = (
  rowValues: CellValue[],
  path: string[],
  value: string | null,
  typeHint?: string,
) => Promise<void>;

interface DocumentListViewProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** Per-cell BSON type trees (MongoDB only) — see `QueryResult.row_types`. */
  rowTypes?: BsonTypeTree[][] | null;
  nullDisplay: string;
  zebraStripes: boolean;
  /** Font size inherited from the grid "zoom" (`gridPrefs.rowHeight`). */
  fontSize?: string | number;
  /** Whether nested containers start expanded (`gridPrefs.listExpandNested`). */
  expandNested: boolean;
  showTypes: boolean;
  lineNumbers: boolean;
  /** Absent when the relation isn't writable (no PK, read-only result). */
  onFieldSave?: FieldSave;
  /** MongoDB only: `$unset` a field. Absent → no delete/add/type affordances,
   *  which is also what tells this component it is rendering a SQL row. */
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  /** Escalate a field to the heavyweight (Monaco) editor. */
  onExpandField?: (
    rowValues: CellValue[],
    path: string[],
    value: string,
    type: string,
  ) => void;
  copyToClipboard: (text: string) => void;
  emptyLabel: string;
  /** Inline INSERT card, pinned above the documents. Absent → this surface
   *  isn't insertable (a pipeline preview, a read-only query result). */
  draft?: ListDraft | null;
}

/**
 * Everything the list view needs to render an inline INSERT as a card.
 *
 * The state itself lives where the table view's draft row already keeps it
 * (`TableDataTab`), and the commit goes through the very same `insert_row`
 * call: switching view mode changes how the draft is *drawn*, never what it
 * writes. That is also why the field set is the result's column list rather
 * than a free-form document builder — on MongoDB those are the top-level keys
 * of the current page, and extra fields are added to the new document with the
 * per-document `+` once it exists.
 */
export interface ListDraft {
  row: DraftRow;
  /** Catalog info per column (PK / nullable / FK / type), when available. */
  columns: ColumnInfo[];
  /** MongoDB: each field may be written as a chosen BSON type. */
  documentMode: boolean;
  bitDisplay: "true_false" | "zero_one";
  connectionId?: string;
  tableSchema?: string;
  /** Receives the first editable control, so the grid can focus it on mount. */
  focusRef?: MutableRefObject<HTMLElement | null>;
  onChange: (column: string, cell: DraftCell) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * The four callbacks `DocumentCard` needs from its caller, mirrored through
 * `callbacksRef` (the same pattern as `DataGrid`'s `interactiveRef` /
 * `rowCallbacksRef` and `GridRow`'s own `callbacksRef`). `DocumentCard` is
 * `memo()`-wrapped, but `onFieldSave`/`onFieldDelete`/`onDeleteRow` arrive
 * here as plain function declarations from `TableDataTab` and `onExpandField`
 * as an inline arrow from `DataGrid` — all four get a fresh identity on every
 * render of a component several layers up, which used to defeat the memo on
 * every single card, every single render, regardless of whether that row's
 * own data had changed. Reading them from a ref instead of a prop means the
 * memo only compares `rowValues`/`columns`/`types` and the boolean
 * capability flags below — the actual functions are always read fresh, at
 * call time, without ever being part of the props diff.
 */
interface DocumentCardCallbacks {
  onFieldSave?: FieldSave;
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  onExpandField?: (
    rowValues: CellValue[],
    path: string[],
    value: string,
    type: string,
  ) => void;
  copyToClipboard: (text: string) => void;
}

/** Field-row copy, precomputed once per language rather than once per field
 *  row — see the `useTranslation()` call below for why. */
interface DocFieldLabels {
  addField: string;
  ctxCopy: string;
  ctxDeleteRow: string;
  deleteField: string;
  collapse: string;
  expand: string;
  setNull: string;
  expandEditor: string;
  opaqueType: string;
  changeType: string;
}

export function DocumentListView({
  columns,
  rows,
  rowTypes,
  nullDisplay,
  zebraStripes,
  fontSize,
  expandNested,
  showTypes,
  lineNumbers,
  onFieldSave,
  onFieldDelete,
  onDeleteRow,
  onExpandField,
  copyToClipboard,
  emptyLabel,
  draft,
}: DocumentListViewProps) {
  const { t, i18n } = useTranslation();
  /**
   * One `useTranslation()` subscription for the whole page of cards, instead
   * of one per `DocumentCard` and one per `FieldRow` (up to ~100 + ~4,000 on
   * a page of wide documents — each a live i18next subscription, each
   * re-rendering on a language change). All ten strings here are static (no
   * interpolation), so they're resolved once into plain strings and handed
   * down as `labels`, which stays referentially stable across renders that
   * don't actually change the language.
   *
   * Deliberately depends on `i18n.language`, not `t` — `t`'s own identity is
   * stable in react-i18next, so keying off it would just re-run this memo on
   * every render for no reason; keying off the language is what actually
   * needs to invalidate these precomputed strings on a live language switch.
   */
  const labels: DocFieldLabels = useMemo(
    () => ({
      addField: t("dataGrid.list.addField"),
      ctxCopy: t("dataGrid.ctxCopy"),
      ctxDeleteRow: t("dataGrid.ctxDeleteRow"),
      deleteField: t("dataGrid.list.deleteField"),
      collapse: t("dataGrid.list.collapse"),
      expand: t("dataGrid.list.expand"),
      setNull: t("cellEditor.setNull"),
      expandEditor: t("dataGrid.expandEditor"),
      opaqueType: t("dataGrid.list.opaqueType"),
      changeType: t("dataGrid.list.changeType"),
    }),
    [i18n.language],
  );

  const callbacksRef = useRef<DocumentCardCallbacks>({
    onFieldSave,
    onFieldDelete,
    onDeleteRow,
    onExpandField,
    copyToClipboard,
  });
  callbacksRef.current = {
    onFieldSave,
    onFieldDelete,
    onDeleteRow,
    onExpandField,
    copyToClipboard,
  };

  // An empty relation gets the shared branded empty frame, the same one the
  // table view shows in place of its rows — an unadorned grey line here was the
  // one place the list view fell out of that family. Suppressed while a draft
  // card is open: the surface is no longer empty, it is a form.
  if (rows.length === 0 && !draft) {
    return <EmptyState size="sm" icon={Inbox} title={emptyLabel} />;
  }
  return (
    <div className="divide-y divide-border/60">
      {draft && (
        <DraftDocumentCard
          columns={columns}
          fontSize={fontSize}
          showTypes={showTypes}
          draft={draft}
        />
      )}
      {rows.map((rowValues, i) => (
        <DocumentCard
          key={i}
          index={i}
          columns={columns}
          rowValues={rowValues}
          types={rowTypes?.[i]}
          nullDisplay={nullDisplay}
          striped={zebraStripes && i % 2 === 1}
          fontSize={fontSize}
          expandNested={expandNested}
          showTypes={showTypes}
          lineNumbers={lineNumbers}
          // Capabilities as booleans, not the functions themselves — see
          // `DocumentCardCallbacks` above. Each `!!x` is recomputed on every
          // render, but a boolean's IDENTITY is itself (`Object.is` on a
          // primitive), so the memo still bails out whenever the capability
          // hasn't actually changed.
          documentMode={!!onFieldDelete}
          hasFieldSave={!!onFieldSave}
          hasDeleteRow={!!onDeleteRow}
          hasExpandField={!!onExpandField}
          t={t}
          labels={labels}
          callbacksRef={callbacksRef}
        />
      ))}
    </div>
  );
}

/**
 * The list view's inline INSERT: one card of `key : <control>` lines, pinned
 * above the documents exactly where the table view pins its draft row.
 *
 * Two deliberate differences from that row:
 *
 * - **Focus leaving the card does not commit.** The row commits on blur because
 *   a grid row is a strip of cells you tab out of; a card is a form, and it
 *   hosts a Radix type picker whose popover lives in a portal *outside* the
 *   card — a blur-commit would fire the INSERT the moment the user opened that
 *   picker. Enter or "Save" commits, Esc or "✕" discards.
 * - **On MongoDB every field carries its own BSON type**, written into the
 *   draft cell and sent as `insert_row`'s type hint. Inferring it from the text
 *   would store `"301353073"` as an `Int32` where the collection holds a
 *   `Long`, which is the fidelity trap gotcha #29 documents one level up.
 */
function DraftDocumentCard({
  columns,
  fontSize,
  showTypes,
  draft,
}: {
  columns: ColumnMeta[];
  fontSize?: string | number;
  showTypes: boolean;
  draft: ListDraft;
}) {
  const { t } = useTranslation();
  const infoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draft.columns) m.set(c.name, c);
    return m;
  }, [draft.columns]);
  const firstEditableIdx = useMemo(
    () => firstEditableColumn(columns, infoByName),
    [columns, infoByName],
  );
  const saving = draft.row.saving;

  function handleKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      draft.onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      draft.onCommit();
    }
  }

  return (
    <div
      className="border-l-2 border-l-primary bg-primary/5 px-3 py-2"
      onKeyDown={handleKeyDown}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 text-3xs font-medium text-primary">
          {saving ? "…" : "+"}
        </span>
        <span className="text-3xs uppercase text-muted-foreground/70">
          {draft.documentMode
            ? t("dataGrid.list.newDocument")
            : t("dataGrid.list.newRow")}
        </span>
        <span className="text-3xs text-muted-foreground/50">
          {t("dataGrid.list.insertHint")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={saving}
            onClick={draft.onCommit}
          >
            {t("common.save")}
          </Button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            title={t("common.cancel")}
            disabled={saving}
            onClick={draft.onCancel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div className="space-y-px" style={{ fontSize }}>
        {columns.map((col, idx) => {
          const cell: DraftCell = draft.row.cells[col.name] ?? {
            value: null,
            touched: false,
          };
          const info = infoByName.get(col.name);
          const type = cell.type ?? draftTypeFor(info?.data_type);
          return (
            <div
              key={col.name}
              className="flex items-center gap-2 font-mono leading-relaxed"
            >
              <span className="w-10 shrink-0" />
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <span className="w-3 shrink-0" />
                <span className="w-32 shrink-0 truncate font-semibold text-foreground/90">
                  {col.name}
                </span>
                <span className="shrink-0 text-muted-foreground/60">:</span>
                <span className="min-w-0 flex-1">
                  <DraftCellControl
                    info={info}
                    cell={cell}
                    saving={saving}
                    autoFocus={idx === firstEditableIdx}
                    focusRef={
                      idx === firstEditableIdx ? draft.focusRef : undefined
                    }
                    connectionId={draft.connectionId}
                    tableSchema={draft.tableSchema}
                    bitDisplay={draft.bitDisplay}
                    onChange={(next) => draft.onChange(col.name, next)}
                  />
                </span>
              </span>
              {showTypes &&
                (draft.documentMode && !isAutoPkColumn(info) ? (
                  // The picker's own Enter / Escape must not reach the card's
                  // keyboard handler below, which reads them as "insert now" /
                  // "discard the draft". Radix renders the popover in a portal,
                  // but a portal still bubbles through the *React* tree, so the
                  // guard has to sit here rather than on the content.
                  <span
                    className="shrink-0"
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Select
                      value={typeValue(type)}
                      onValueChange={(v) =>
                        draft.onChange(col.name, {
                          ...cell,
                          type: v as BsonType,
                        })
                      }
                    >
                      <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BSON_TYPES.map((bsonType) => (
                          <SelectItem
                            key={bsonType}
                            value={bsonType}
                            className="text-xs"
                          >
                            {typeLabel(bsonType)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                ) : (
                  <span className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60">
                    {info?.data_type ?? col.data_type}
                  </span>
                ))}
            </div>
          );
        })}
      </div>

      {draft.row.error && (
        <div className="mt-1 rounded-sm bg-destructive/10 px-2 py-1 text-3xs text-destructive">
          {draft.row.error}
        </div>
      )}
    </div>
  );
}

interface DocumentCardProps {
  index: number;
  columns: ColumnMeta[];
  rowValues: CellValue[];
  types?: BsonTypeTree[];
  nullDisplay: string;
  striped: boolean;
  fontSize?: string | number;
  expandNested: boolean;
  showTypes: boolean;
  lineNumbers: boolean;
  /** Derived from which callbacks the caller supplied (see
   *  `DocumentCardCallbacks`) — plain booleans instead of the functions
   *  themselves, so this component's `memo()` reacts to a capability
   *  actually changing rather than to a new function identity on every
   *  render of something several layers up. The functions themselves are
   *  read from `callbacksRef`. */
  documentMode: boolean;
  hasFieldSave: boolean;
  hasDeleteRow: boolean;
  hasExpandField: boolean;
  /** `t`'s own identity is stable in react-i18next, so passing it through
   *  props doesn't fight the memo — only needed here for the few strings
   *  that interpolate a value computed per field (a count, a path, a type
   *  name); everything static comes from `labels` instead. */
  t: TFunction;
  labels: DocFieldLabels;
  callbacksRef: MutableRefObject<DocumentCardCallbacks>;
}

/** Inline edit in flight, narrowed to the one field it belongs to. */
interface EditState {
  key: string;
  text: string | null;
  type: string;
}

/** A field being added: its parent container plus the key/type/value form. */
interface DraftState {
  parent: string[];
  /** Index in the parent's child list to insert after (arrays append, so this
   *  is only used to position the draft row visually). */
  afterKey: string | null;
  key: string;
  type: BsonType;
  text: string;
  inArray: boolean;
}

/**
 * The subset of `FieldRow`'s interaction surface that used to be ~13 inline
 * arrow functions built fresh per field, per render (`~52k` closures on a
 * page of 100 rows × 40 fields wide with the type menu open). `FieldRow` is
 * `memo()`-wrapped, so those inline arrows — a new function identity every
 * time regardless of whether that field actually changed — defeated it just
 * as thoroughly as `DocumentCard`'s own unstable callback props did. Built
 * once per `DocumentCard` render as a ref (the same `interactiveRef` /
 * `rowCallbacksRef` pattern `DataGrid` and `GridRow` already use) rather
 * than per field, and each method takes the field it acts on as an
 * argument instead of closing over one particular field — that's what lets
 * every `FieldRow` share the exact same, stable `actionsRef` object.
 */
interface FieldRowActions {
  openTypeMenu: (key: string) => void;
  closeTypeMenu: () => void;
  toggleFold: (key: string) => void;
  startEdit: (f: DocField) => void;
  editChange: (value: string | null) => void;
  commitEdit: (f: DocField) => void;
  cancelEdit: () => void;
  changeType: (f: DocField, next: BsonType) => void;
  deleteField: (f: DocField) => void;
  addAfter: (f: DocField) => void;
  expandField: (f: DocField) => void;
}

const DocumentCard = memo(function DocumentCard({
  index,
  columns,
  rowValues,
  types,
  nullDisplay,
  striped,
  fontSize,
  expandNested,
  showTypes,
  lineNumbers,
  documentMode,
  hasFieldSave,
  hasDeleteRow,
  hasExpandField,
  t,
  labels,
  callbacksRef,
}: DocumentCardProps) {
  /**
   * Folds the user toggled, as a *diff* from the `listExpandNested`
   * preference rather than an absolute set: with the preference off a path in
   * here is open, with it on a path in here is closed. Storing the diff is
   * what lets the preference be flipped at runtime without stale per-card
   * state fighting it.
   */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [edit, setEdit] = useState<EditState | null>(null);
  /**
   * Path key of the field whose type picker is open. The picker is mounted
   * only for that one field: a Radix `Select` per line would mean thousands of
   * mounted popovers on a page of wide documents, for a control used once in a
   * while. Closed, it is a plain button showing the type label.
   */
  const [typeMenu, setTypeMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  /** Guards against a blur-commit racing the Enter-commit of the same edit. */
  const committingRef = useRef(false);

  const isExpanded = useCallback(
    (key: string) => (toggled.has(key) ? !expandNested : expandNested),
    [toggled, expandNested],
  );

  const fields = useMemo(
    () => flattenDocument(columns, rowValues, types, isExpanded),
    [columns, rowValues, types, isExpanded],
  );

  /** Column catalog type by name, for `typeTextFor` — memoized once per
   *  column list instead of a `columns.find()` per field per render (O(fields
   *  × columns), ~160,000 string comparisons on a page of 100 rows × 40
   *  columns). */
  const columnTypeByName = useMemo(
    () => new Map(columns.map((c) => [c.name, c.data_type])),
    [columns],
  );

  function toggleFold(key: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** A MongoDB document's `_id` is immutable server-side: `$set` on it errors
   *  and `$unset` would orphan the document. It is read-only here rather than
   *  offering edits that can only fail — the same call Compass makes. */
  function isImmutableId(f: DocField): boolean {
    return documentMode && f.path.length === 1 && f.path[0] === "_id";
  }

  /**
   * Whether the backend can address this field at all. MongoDB takes a dotted
   * update path, so any depth works; a SQL `UPDATE` names a *column*, so only
   * a top-level field is addressable — the contents of a JSON column are
   * edited by rewriting the whole column value (expand it, one level up).
   */
  function isAddressable(f: DocField): boolean {
    return documentMode || f.path.length === 1;
  }

  /** Whether this field's value may be edited inline. */
  function canEdit(f: DocField): boolean {
    return hasFieldSave && f.editable && isAddressable(f) && !isImmutableId(f);
  }

  /** Whether this field may be retyped, removed, or have a sibling added.
   *  Unlike {@link canEdit} this stays true for an opaque type — replacing it
   *  via the type picker is exactly how such a field is edited at all. */
  function canMutate(f: DocField): boolean {
    return documentMode && hasFieldSave && !isImmutableId(f);
  }

  async function save(
    path: string[],
    value: string | null,
    typeHint?: string,
  ): Promise<boolean> {
    const onFieldSave = callbacksRef.current.onFieldSave;
    if (!onFieldSave) return false;
    try {
      await onFieldSave(rowValues, path, value, typeHint);
      return true;
    } catch (e) {
      notify.error(String(e));
      return false;
    }
  }

  function startEdit(f: DocField) {
    if (!canEdit(f)) return;
    setEdit({
      key: pathKey(f.path),
      text:
        f.value === null || f.value === undefined
          ? null
          : editText(f.value, f.type),
      type: f.type,
    });
  }

  async function commitEdit(f: DocField) {
    if (!edit || committingRef.current) return;
    const original =
      f.value === null || f.value === undefined
        ? null
        : editText(f.value, f.type);
    if (edit.text === original) {
      setEdit(null);
      return;
    }
    // A field that was null/undefined has no type to preserve, so the first
    // value typed into it is written as a string — the type picker (MongoDB)
    // is how any other type is chosen deliberately.
    const hint =
      edit.text !== null && (f.type === "null" || f.type === "undefined")
        ? "string"
        : f.type;
    if (edit.text !== null && !isValidForType(hint, edit.text)) {
      notify.error(t("dataGrid.list.invalidValue", { type: typeLabel(hint) }));
      return;
    }
    committingRef.current = true;
    setEdit(null);
    await save(f.path, edit.text, hint);
    committingRef.current = false;
  }

  /**
   * Rewrite the field with a different BSON type. The current value is reused
   * when it is a plausible spelling of the new type, otherwise the type's
   * neutral default is written — switching `String` → `Object` on the text
   * `"hello"` has to produce *something*, and an empty document is the answer
   * that loses the least.
   */
  async function changeType(f: DocField, next: BsonType) {
    if (next === f.type) return;
    const current =
      f.value === null || f.value === undefined
        ? ""
        : editText(f.value, f.type);
    const text = isValidForType(next, current) ? current : defaultText(next);
    await save(f.path, next === "null" ? null : text, next);
  }

  async function deleteField(f: DocField) {
    const onFieldDelete = callbacksRef.current.onFieldDelete;
    if (!onFieldDelete) return;
    if (
      !confirmDestructive(
        t("dataGrid.list.confirmDeleteField", { field: pathKey(f.path) }),
      )
    ) {
      return;
    }
    try {
      await onFieldDelete(rowValues, f.path);
    } catch (e) {
      notify.error(String(e));
    }
  }

  /** Open the "new field" form under `f`: inside it when it is an expanded
   *  container, next to it otherwise. */
  function startDraft(f: DocField) {
    const intoContainer = f.container !== null && f.expanded;
    const parent = intoContainer ? f.path : f.path.slice(0, -1);
    const inArray = intoContainer ? f.container === "array" : f.inArray;
    setDraft({
      parent,
      afterKey: pathKey(f.path),
      key: inArray ? String(nextArrayIndex(fields, parent)) : "",
      type: "string",
      text: "",
      inArray,
    });
  }

  async function commitDraft() {
    if (!draft) return;
    const key = draft.key.trim();
    if (!key) {
      notify.error(t("dataGrid.list.fieldNameRequired"));
      return;
    }
    if (draft.type !== "null" && !isValidForType(draft.type, draft.text)) {
      notify.error(
        t("dataGrid.list.invalidValue", { type: typeLabel(draft.type) }),
      );
      return;
    }
    const ok = await save(
      [...draft.parent, key],
      draft.type === "null" ? null : draft.text,
      draft.type,
    );
    if (ok) setDraft(null);
  }

  /** Document-level affordance: "add a field to this document" (the root
   *  counterpart of the per-field `+`). */
  const canAddRootField = documentMode && hasFieldSave;

  // Built fresh every `DocumentCard` render (mirroring `interactiveRef` /
  // `rowCallbacksRef`), NOT memoized with an empty dependency array — its
  // methods close over this render's `edit`/`toggled`/`typeMenu`/`draft`
  // local state, same as `toggleFold`/`startEdit`/etc. themselves. What
  // stays constant across renders is the `actionsRef` OBJECT's identity
  // (it's a ref), which is all `memo(FieldRow)` ever sees as a prop.
  const actionsRef = useRef<FieldRowActions>({
    openTypeMenu: (key) => setTypeMenu(key),
    closeTypeMenu: () => setTypeMenu(null),
    toggleFold,
    startEdit,
    editChange: (value) =>
      setEdit((prev) => (prev ? { ...prev, text: value } : prev)),
    commitEdit: (f) => void commitEdit(f),
    cancelEdit: () => setEdit(null),
    changeType: (f, next) => void changeType(f, next),
    deleteField: (f) => void deleteField(f),
    addAfter: startDraft,
    expandField: (f) => {
      const onExpandField = callbacksRef.current.onExpandField;
      if (!onExpandField || !isAddressable(f)) return;
      onExpandField(
        rowValues,
        f.path,
        f.value === null || f.value === undefined
          ? ""
          : editText(f.value, f.type),
        f.type,
      );
    },
  });
  actionsRef.current = {
    openTypeMenu: (key) => setTypeMenu(key),
    closeTypeMenu: () => setTypeMenu(null),
    toggleFold,
    startEdit,
    editChange: (value) =>
      setEdit((prev) => (prev ? { ...prev, text: value } : prev)),
    commitEdit: (f) => void commitEdit(f),
    cancelEdit: () => setEdit(null),
    changeType: (f, next) => void changeType(f, next),
    deleteField: (f) => void deleteField(f),
    addAfter: startDraft,
    expandField: (f) => {
      const onExpandField = callbacksRef.current.onExpandField;
      if (!onExpandField || !isAddressable(f)) return;
      onExpandField(
        rowValues,
        f.path,
        f.value === null || f.value === undefined
          ? ""
          : editText(f.value, f.type),
        f.type,
      );
    },
  };

  return (
    <div className={cn("group/doc px-3 py-2", striped && "bg-muted/30")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 tabular-nums text-3xs text-muted-foreground">
          {index + 1}
        </span>
        <span className="text-3xs uppercase text-muted-foreground/50">
          {t("dataGrid.fieldsCount", { count: columns.length })}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover/doc:opacity-100">
          {canAddRootField && (
            <IconButton
              icon={Plus}
              label={labels.addField}
              onClick={() =>
                setDraft({
                  parent: [],
                  afterKey: null,
                  key: "",
                  type: "string",
                  text: "",
                  inArray: false,
                })
              }
            />
          )}
          <IconButton
            icon={Copy}
            label={labels.ctxCopy}
            onClick={() =>
              callbacksRef.current.copyToClipboard(
                rowToJson(rowValues, columns),
              )
            }
          />
          {hasDeleteRow && (
            <IconButton
              icon={Trash2}
              tone="destructive"
              label={labels.ctxDeleteRow}
              onClick={() => callbacksRef.current.onDeleteRow?.(rowValues)}
            />
          )}
        </span>
      </div>

      <div className="space-y-px" style={{ fontSize }}>
        {draft && draft.afterKey === null && (
          <DraftRow
            draft={draft}
            depth={0}
            onChange={setDraft}
            onCommit={() => void commitDraft()}
            onCancel={() => setDraft(null)}
          />
        )}
        {fields.map((f, i) => {
          const key = pathKey(f.path);
          const editing = edit?.key === key;
          return (
            <div key={key}>
              <FieldRow
                field={f}
                line={i + 1}
                lineNumbers={lineNumbers}
                showTypes={showTypes}
                typeText={typeTextFor(f, documentMode, columnTypeByName)}
                nullDisplay={nullDisplay}
                editing={editing}
                editText={edit?.text ?? null}
                canEdit={canEdit(f)}
                canMutate={canMutate(f)}
                canExpand={hasExpandField && isAddressable(f)}
                typeMenuOpen={typeMenu === key}
                labels={labels}
                actionsRef={actionsRef}
              />
              {draft && draft.afterKey === key && (
                <DraftRow
                  draft={draft}
                  depth={f.container && f.expanded ? f.depth + 1 : f.depth}
                  onChange={setDraft}
                  onCommit={() => void commitDraft()}
                  onCancel={() => setDraft(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface FieldRowProps {
  field: DocField;
  line: number;
  lineNumbers: boolean;
  showTypes: boolean;
  typeText: string;
  nullDisplay: string;
  editing: boolean;
  editText: string | null;
  canEdit: boolean;
  /** MongoDB: the add/delete/retype gutter is available. */
  canMutate: boolean;
  /** Whether the expand-to-Monaco button is shown for this field. */
  canExpand: boolean;
  /** Whether this row's type picker is the one currently mounted. */
  typeMenuOpen: boolean;
  labels: DocFieldLabels;
  /** Stable across renders — see `FieldRowActions`. Every method takes the
   *  field it acts on, so `FieldRow` never needs a field-specific callback
   *  identity to stay memo-safe. */
  actionsRef: MutableRefObject<FieldRowActions>;
}

const FieldRow = memo(function FieldRow({
  field: f,
  line,
  lineNumbers,
  showTypes,
  typeText,
  nullDisplay,
  editing,
  editText: text,
  canEdit,
  canMutate,
  canExpand,
  typeMenuOpen,
  labels,
  actionsRef,
}: FieldRowProps) {
  const isNull = f.value === null || f.value === undefined;
  return (
    <div className="group/field flex items-center gap-2 font-mono leading-relaxed hover:bg-accent">
      {/* Left gutter: per-field actions, revealed on hover so the reading
          rhythm of the document isn't broken by a column of icons. */}
      <span className="flex w-10 shrink-0 items-center justify-end gap-0.5">
        {canMutate && (
          <>
            <IconButton
              size="xs"
              icon={Trash2}
              tone="destructive"
              revealOnHover="field"
              label={labels.deleteField}
              onClick={() => actionsRef.current.deleteField(f)}
            />
            <IconButton
              size="xs"
              icon={Plus}
              revealOnHover="field"
              label={labels.addField}
              className="border border-border"
              onClick={() => actionsRef.current.addAfter(f)}
            />
          </>
        )}
      </span>
      {lineNumbers && (
        <span className="w-6 shrink-0 select-none text-right tabular-nums text-3xs text-muted-foreground/50">
          {line}
        </span>
      )}
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingLeft: f.depth * 14 }}
      >
        {f.container ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground/70 hover:text-foreground"
            onClick={() => actionsRef.current.toggleFold(pathKey(f.path))}
            title={f.expanded ? labels.collapse : labels.expand}
          >
            {f.expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 font-semibold text-foreground/90">
          {f.key}
        </span>
        <span className="shrink-0 text-muted-foreground/60">:</span>
        {editing ? (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <input
              autoFocus
              className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
              placeholder={text === null ? nullDisplay : ""}
              value={text ?? ""}
              onChange={(e) => actionsRef.current.editChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  actionsRef.current.commitEdit(f);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  actionsRef.current.cancelEdit();
                }
              }}
              onBlur={() => actionsRef.current.commitEdit(f)}
            />
            <button
              type="button"
              tabIndex={-1}
              title={labels.setNull}
              className="shrink-0 rounded-sm px-1 text-3xs text-muted-foreground/60 hover:text-foreground"
              // Keep focus on the input: a blur here would commit the old
              // text before the NULL ever lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => actionsRef.current.editChange(null)}
            >
              ∅
            </button>
          </span>
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              canEdit && "cursor-text",
              isNull
                ? "italic text-muted-foreground"
                : f.container
                  ? "text-muted-foreground"
                  : valueClass(f.type),
            )}
            title={f.editable ? undefined : labels.opaqueType}
            onDoubleClick={() =>
              f.container
                ? actionsRef.current.toggleFold(pathKey(f.path))
                : actionsRef.current.startEdit(f)
            }
          >
            {displayValue(f, nullDisplay)}
          </span>
        )}
        {canExpand && (
          <IconButton
            size="xs"
            icon={Maximize2}
            revealOnHover="field"
            label={labels.expandEditor}
            className="shrink-0"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => actionsRef.current.expandField(f)}
          />
        )}
      </span>
      {showTypes &&
        (canMutate && typeMenuOpen ? (
          <Select
            open
            value={typeValue(f.type)}
            onOpenChange={(open) => !open && actionsRef.current.closeTypeMenu()}
            onValueChange={(v) => {
              actionsRef.current.closeTypeMenu();
              actionsRef.current.changeType(f, v as BsonType);
            }}
          >
            <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
              <SelectValue>{typeText}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BSON_TYPES.map((type) => (
                <SelectItem key={type} value={type} className="text-xs">
                  {typeLabel(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : canMutate ? (
          <button
            type="button"
            className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60 hover:text-foreground"
            title={labels.changeType}
            onClick={() => actionsRef.current.openTypeMenu(pathKey(f.path))}
          >
            {typeText}
          </button>
        ) : (
          <span className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60">
            {typeText}
          </span>
        ))}
    </div>
  );
});

/** The "new field" form row: key, type and value, committed as one `$set`. */
function DraftRow({
  draft,
  depth,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: DraftState;
  depth: number;
  onChange: (next: DraftState) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 font-mono leading-relaxed">
      <span className="w-10 shrink-0" />
      <span className="w-6 shrink-0" />
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="w-3 shrink-0" />
        <input
          autoFocus
          className="h-5 w-32 shrink-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
          placeholder={t("dataGrid.list.fieldName")}
          value={draft.key}
          // An array's new element is appended at its next index: naming it
          // anything else would create a sparse object-like key.
          disabled={draft.inArray}
          onChange={(e) => onChange({ ...draft, key: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
        <span className="shrink-0 text-muted-foreground/60">:</span>
        <input
          className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
          placeholder={t("dataGrid.list.fieldValue")}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded-sm px-1 text-3xs text-brand hover:underline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCommit}
        >
          {t("common.add")}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-sm px-1 text-muted-foreground/70 hover:text-foreground"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
          title={t("common.cancel")}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
      <Select
        value={draft.type}
        onValueChange={(v) => onChange({ ...draft, type: v as BsonType })}
      >
        <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BSON_TYPES.map((type) => (
            <SelectItem key={type} value={type} className="text-xs">
              {typeLabel(type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Colour a scalar by its type, the way a JSON viewer would. */
function valueClass(type: string): string {
  switch (type) {
    case "string":
    case "symbol":
    case "javascript":
      return "text-success";
    case "int":
    case "long":
    case "double":
    case "decimal128":
      return "text-numeric";
    case "bool":
      return "text-warning";
    case "objectId":
    case "uuid":
      return "text-pk";
    case "date":
    case "timestamp":
      return "text-fk";
    default:
      return "text-foreground/80";
  }
}

/**
 * BSON type a *new* field should default to, from the type the collection was
 * sampled as. `describe_table` reports a nested document as `"document"` while
 * the picker (and the backend's type-hint vocabulary) spells it `"object"`, so
 * that one name is translated rather than silently falling through to `string`.
 */
