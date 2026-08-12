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

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Maximize2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
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
  displayValue,
  editText,
  flattenDocument,
  isValidForType,
  pathKey,
  typeLabel,
  type BsonType,
  type DocField,
} from "@/lib/grid/documentTree";
import { cn } from "@/lib/utils";
import type { BsonTypeTree, CellValue, ColumnMeta } from "@/types";

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
}: DocumentListViewProps) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="divide-y divide-border/60">
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
          onFieldSave={onFieldSave}
          onFieldDelete={onFieldDelete}
          onDeleteRow={onDeleteRow}
          onExpandField={onExpandField}
          copyToClipboard={copyToClipboard}
        />
      ))}
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
  onFieldSave,
  onFieldDelete,
  onDeleteRow,
  onExpandField,
  copyToClipboard,
}: DocumentCardProps) {
  const { t } = useTranslation();
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

  /** MongoDB-only affordances (add / delete / retype a field) ride on the
   *  presence of the `$unset` callback — only the Mongo tab supplies it. */
  const documentMode = !!onFieldDelete;

  const isExpanded = useCallback(
    (key: string) => (toggled.has(key) ? !expandNested : expandNested),
    [toggled, expandNested],
  );

  const fields = useMemo(
    () => flattenDocument(columns, rowValues, types, isExpanded),
    [columns, rowValues, types, isExpanded],
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
    return !!onFieldSave && f.editable && isAddressable(f) && !isImmutableId(f);
  }

  /** Whether this field may be retyped, removed, or have a sibling added.
   *  Unlike {@link canEdit} this stays true for an opaque type — replacing it
   *  via the type picker is exactly how such a field is edited at all. */
  function canMutate(f: DocField): boolean {
    return documentMode && !!onFieldSave && !isImmutableId(f);
  }

  async function save(
    path: string[],
    value: string | null,
    typeHint?: string,
  ): Promise<boolean> {
    if (!onFieldSave) return false;
    try {
      await onFieldSave(rowValues, path, value, typeHint);
      return true;
    } catch (e) {
      toast.error(String(e));
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
      toast.error(t("dataGrid.list.invalidValue", { type: typeLabel(hint) }));
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
      toast.error(String(e));
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
      toast.error(t("dataGrid.list.fieldNameRequired"));
      return;
    }
    if (draft.type !== "null" && !isValidForType(draft.type, draft.text)) {
      toast.error(
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
  const canAddRootField = documentMode && !!onFieldSave;

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
            <button
              type="button"
              className="rounded p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              title={t("dataGrid.list.addField")}
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
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            title={t("dataGrid.ctxCopy")}
            onClick={() => copyToClipboard(rowToJson(rowValues, columns))}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          {onDeleteRow && (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
              title={t("dataGrid.ctxDeleteRow")}
              onClick={() => onDeleteRow(rowValues)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
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
                // A SQL top-level field shows its real column type
                // (`varchar(255)`, `jsonb`) rather than the JSON shape it
                // arrived as; nested values inside a JSON column, and every
                // MongoDB field, show the BSON-style label. Resolved by column
                // *name*: `i` is the flattened display index, which stops
                // matching the column list as soon as anything is expanded.
                typeText={
                  documentMode || f.depth > 0
                    ? typeLabel(f.type)
                    : (columns.find((c) => c.name === f.path[0])?.data_type ??
                      typeLabel(f.type))
                }
                nullDisplay={nullDisplay}
                editing={editing}
                editText={edit?.text ?? null}
                canEdit={canEdit(f)}
                canMutate={canMutate(f)}
                typeMenuOpen={typeMenu === key}
                onOpenTypeMenu={() => setTypeMenu(key)}
                onCloseTypeMenu={() => setTypeMenu(null)}
                onToggleFold={() => toggleFold(key)}
                onStartEdit={() => startEdit(f)}
                onEditChange={(v) =>
                  setEdit((prev) => (prev ? { ...prev, text: v } : prev))
                }
                onCommit={() => void commitEdit(f)}
                onCancel={() => setEdit(null)}
                onChangeType={(next) => void changeType(f, next)}
                onDelete={() => void deleteField(f)}
                onAdd={() => startDraft(f)}
                onExpand={
                  onExpandField && isAddressable(f)
                    ? () =>
                        onExpandField(
                          rowValues,
                          f.path,
                          f.value === null || f.value === undefined
                            ? ""
                            : editText(f.value, f.type),
                          f.type,
                        )
                    : undefined
                }
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
  /** Whether this row's type picker is the one currently mounted. */
  typeMenuOpen: boolean;
  onOpenTypeMenu: () => void;
  onCloseTypeMenu: () => void;
  onToggleFold: () => void;
  onStartEdit: () => void;
  onEditChange: (value: string | null) => void;
  onCommit: () => void;
  onCancel: () => void;
  onChangeType: (type: BsonType) => void;
  onDelete: () => void;
  onAdd: () => void;
  onExpand?: () => void;
}

function FieldRow({
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
  typeMenuOpen,
  onOpenTypeMenu,
  onCloseTypeMenu,
  onToggleFold,
  onStartEdit,
  onEditChange,
  onCommit,
  onCancel,
  onChangeType,
  onDelete,
  onAdd,
  onExpand,
}: FieldRowProps) {
  const { t } = useTranslation();
  const isNull = f.value === null || f.value === undefined;
  return (
    <div className="group/field flex items-center gap-2 font-mono leading-relaxed hover:bg-accent/30">
      {/* Left gutter: per-field actions, revealed on hover so the reading
          rhythm of the document isn't broken by a column of icons. */}
      <span className="flex w-10 shrink-0 items-center justify-end gap-0.5">
        {canMutate && (
          <>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:text-destructive group-hover/field:opacity-100"
              title={t("dataGrid.list.deleteField")}
              onClick={onDelete}
            >
              <Trash2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="rounded border border-border p-0.5 text-muted-foreground/60 opacity-0 hover:text-foreground group-hover/field:opacity-100"
              title={t("dataGrid.list.addField")}
              onClick={onAdd}
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
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
            onClick={onToggleFold}
            title={
              f.expanded
                ? t("dataGrid.list.collapse")
                : t("dataGrid.list.expand")
            }
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
              className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={text === null ? nullDisplay : ""}
              value={text ?? ""}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCommit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                }
              }}
              onBlur={onCommit}
            />
            <button
              type="button"
              tabIndex={-1}
              title={t("cellEditor.setNull")}
              className="shrink-0 rounded px-1 text-3xs text-muted-foreground/60 hover:text-foreground"
              // Keep focus on the input: a blur here would commit the old
              // text before the NULL ever lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onEditChange(null)}
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
            title={f.editable ? undefined : t("dataGrid.list.opaqueType")}
            onDoubleClick={() => (f.container ? onToggleFold() : onStartEdit())}
          >
            {displayValue(f, nullDisplay)}
          </span>
        )}
        {onExpand && (
          <button
            type="button"
            tabIndex={-1}
            className="shrink-0 rounded px-1 text-muted-foreground/60 opacity-0 hover:text-foreground group-hover/field:opacity-100"
            title={t("dataGrid.expandEditor")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onExpand}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        )}
      </span>
      {showTypes &&
        (canMutate && typeMenuOpen ? (
          <Select
            open
            value={typeValue(f.type)}
            onOpenChange={(open) => !open && onCloseTypeMenu()}
            onValueChange={(v) => {
              onCloseTypeMenu();
              onChangeType(v as BsonType);
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
            title={t("dataGrid.list.changeType")}
            onClick={onOpenTypeMenu}
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
}

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
          className="h-5 w-32 shrink-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:ring-1 focus:ring-ring"
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
          className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:ring-1 focus:ring-ring"
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
          className="shrink-0 rounded px-1 text-3xs text-brand hover:underline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCommit}
        >
          {t("common.add")}
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1 text-muted-foreground/70 hover:text-foreground"
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

/** The picker only knows the types it can write; anything else (a `dbPointer`,
 *  a `mixed` column) shows its own label but maps onto `string` as the
 *  selected item so the Radix trigger has a valid value. */
function typeValue(type: string): string {
  return (BSON_TYPES as readonly string[]).includes(type) ? type : "string";
}

/** Neutral value for a type the current text can't be reinterpreted as. */
function defaultText(type: BsonType): string {
  switch (type) {
    case "int":
    case "long":
    case "double":
    case "decimal128":
      return "0";
    case "bool":
      return "false";
    case "object":
      return "{}";
    case "array":
      return "[]";
    case "date":
      return new Date().toISOString();
    default:
      return "";
  }
}

/** Next free index for a new element appended to the array at `parent`. */
function nextArrayIndex(fields: DocField[], parent: string[]): number {
  const container = fields.find((f) => pathKey(f.path) === pathKey(parent));
  return container?.childCount ?? 0;
}
