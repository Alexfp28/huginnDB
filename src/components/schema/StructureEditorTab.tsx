/**
 * Visual table-structure editor (HeidiSQL-style). Edits columns, indexes and
 * foreign keys of an existing table, or designs a new one. The component never
 * builds SQL itself: it sends the desired `TableStructure` (plus the original
 * snapshot when editing) to the backend, which generates the DDL. A read-only
 * Monaco pane previews that DDL live; Apply executes it.
 *
 * State model: the working structure lives in local React state (ephemeral per
 * tab — dockview keeps the panel mounted). The loaded `original` is kept
 * separately so the backend can diff. Each column carries a stable `originalName`
 * so a rename is distinguishable from a drop+add (the Rust diff matches on it).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Plus, Trash2, RefreshCw, ChevronUp, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import Editor from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { SchemaBindingBadge } from "@/components/jsonSchema/SchemaBindingBadge";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useSchema } from "@/stores/session/schema";
import { useTabs, retitleTabsForTableRename } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences/preferences";
import { resolveMonacoTheme } from "@/lib/monaco/monaco-themes";
import {
  columnCategoriesFor,
  composeColumnType,
  parseColumnType,
  type ColumnTypeCategory,
} from "@/lib/db/columnTypes";
import {
  ddlReadOnlyReason,
  supportsColumnReorder,
  supportsDdlEditing,
  supportsIndexManager,
  supportsUnsignedIntegers,
} from "@/lib/db/driver";
import type {
  ColumnDef,
  Driver,
  StructureIndexDef,
  ForeignKeyDef,
  StructureMode,
  TableStructure,
} from "@/types";

interface Props {
  tabId: string;
  connectionId: string;
  schema?: string;
  table?: string;
  mode: StructureMode;
}

let keySeq = 0;
const nextKey = () => `c${keySeq++}`;

/** Working column = ColumnDef + a stable client key for React lists. */
type WorkingColumn = ColumnDef & { _key: string };

/** A sensible starting type for a freshly-added column: the catalog's own
 *  "varchar"-ish text entry, composed with its default length, so a new
 *  column always lands in the categorised picker instead of the "custom
 *  type" fallback (which a hardcoded literal like "varchar(255)" would hit
 *  on SQLite, where the catalog's text type is spelled "TEXT"). */
function defaultColumnType(categories: ColumnTypeCategory[]): string {
  const textTypes = categories.find((c) => c.key === "text")?.types ?? [];
  const candidate =
    textTypes.find((t) => /^varchar$/i.test(t.name)) ?? textTypes[0];
  if (!candidate) return "varchar(255)";
  return composeColumnType({
    baseType: candidate.name,
    length: candidate.defaultLength ?? "",
    unsigned: false,
    zerofill: false,
    custom: "",
  });
}

function blankColumn(dataType: string): WorkingColumn {
  return {
    _key: nextKey(),
    name: "",
    originalName: null,
    dataType,
    nullable: true,
    default: null,
    isPrimaryKey: false,
    autoIncrement: false,
  };
}

export function StructureEditorTab({
  tabId,
  connectionId,
  schema,
  table,
  mode,
}: Props) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  const refreshSchema = useSchema((s) => s.refresh);
  const closeTab = useTabs((s) => s.close);
  // Drives the type suggestions. Synthetic multi-DB ids inherit the parent
  // profile's driver — the hook handles that fold.
  const driver = useConnectionDriver(connectionId);
  const typeCategories = useMemo(() => columnCategoriesFor(driver), [driver]);

  // Read-only on the drivers whose DDL the backend can't build yet: MongoDB
  // (no SQL DDL at all — the tab shows inferred fields + real indexes) and
  // SQL Server (the catalog introspection is complete, only the T-SQL builder
  // is missing). Both reject preview/apply, so the Apply action is replaced by
  // a badge instead of failing on click.
  const isReadOnly = !supportsDdlEditing(driver);

  const [original, setOriginal] = useState<TableStructure | null>(null);
  const [name, setName] = useState(table ?? "");
  const [columns, setColumns] = useState<WorkingColumn[]>(
    mode === "new" ? [blankColumn(defaultColumnType(typeCategories))] : [],
  );
  const [indexes, setIndexes] = useState<StructureIndexDef[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyDef[]>([]);
  const [section, setSection] = useState<"columns" | "indexes" | "fks">(
    "columns",
  );
  const [loading, setLoading] = useState(mode === "edit");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ddl, setDdl] = useState<string>("");
  const [rebuild, setRebuild] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  // The table's current name, tracked outside React state: the `table` prop
  // is whatever the tab was opened/panel-created with and never updates on
  // its own (dockview panel params are fixed at creation), so a rename via
  // Apply would otherwise leave `reload` re-fetching a name that no longer
  // exists. A ref (not state) so updating it never re-triggers the mount
  // effect below.
  const currentTableNameRef = useRef(table);

  // (Re)load the existing structure from the server. Runs on mount and from
  // the manual refresh button (issue #25) so external changes made while the
  // tab is open can be pulled in; a refresh resets the working state to the
  // server's current definition.
  const reload = useCallback(async () => {
    const currentName = currentTableNameRef.current;
    if (mode !== "edit" || !currentName) return;
    setLoading(true);
    try {
      const s = await api.getTableStructure(connectionId, schema, currentName);
      currentTableNameRef.current = s.name;
      setOriginal(s);
      setName(s.name);
      setColumns(s.columns.map((c) => ({ ...c, _key: nextKey() })));
      setIndexes(s.indexes);
      setForeignKeys(s.foreignKeys);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [mode, connectionId, schema]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // JSON Schema bindings for this table.
  //
  // Deliberately in their own state, NOT on `WorkingColumn`: a binding is local
  // editor metadata, not DDL. `desired` below is built with
  // `columns.map(({ _key, ...c }) => c)`, so a field added to `WorkingColumn`
  // would ride into the `preview_structure_change` payload unless someone
  // remembered to strip it — and would re-trigger the debounced DDL preview on
  // every pick. Keeping it in a separate map makes that impossible by
  // construction (gotcha #16).
  // Only the warm-up call lives here; each badge reads the cache itself.
  const ensureResolvedSchemas = useJsonSchemas((s) => s.ensureResolved);
  const schemaRevision = useJsonSchemas((s) => s.revision);
  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns],
  );
  useEffect(() => {
    if (mode !== "edit" || columnNames.length === 0) return;
    void ensureResolvedSchemas(connectionId, schema, name, columnNames);
  }, [
    mode,
    connectionId,
    schema,
    name,
    columnNames,
    ensureResolvedSchemas,
    schemaRevision,
  ]);

  /** Assemble the desired structure from the working state. */
  const desired = useMemo<TableStructure>(
    () => ({
      schema: schema ?? null,
      name: name.trim(),
      columns: columns.map(({ _key, ...c }) => c),
      indexes,
      foreignKeys,
    }),
    [schema, name, columns, indexes, foreignKeys],
  );

  // Debounced DDL preview. Re-runs whenever the desired structure changes.
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const runPreview = useCallback(() => {
    // MongoDB has no DDL preview; structure is read-only here.
    if (isReadOnly) {
      setDdl("");
      setPreviewError(null);
      return;
    }
    if (!desiredRef.current.name || desiredRef.current.columns.length === 0) {
      setDdl("");
      setPreviewError(null);
      return;
    }
    api
      .previewStructureChange({
        connectionId,
        original,
        desired: desiredRef.current,
      })
      .then((p) => {
        setDdl(p.statements.join(";\n") + (p.statements.length ? ";" : ""));
        setRebuild(p.rebuild);
        setPreviewError(null);
      })
      .catch((e) => {
        setDdl("");
        setPreviewError(String(e));
      });
  }, [connectionId, original, isReadOnly]);

  useEffect(() => {
    const id = setTimeout(runPreview, 400);
    return () => clearTimeout(id);
  }, [desired, runPreview]);

  async function doApply() {
    setApplying(true);
    setPreviewError(null);
    // Captured before `applyStructureChange` — `original` (React state)
    // still reflects the pre-apply snapshot at this point in the closure.
    const priorName = original?.name;
    try {
      await api.applyStructureChange({ connectionId, original, desired });
      // Follow column renames so a binding does not silently stop matching.
      // Best-effort on purpose: the DDL has already run, so a failure here is a
      // toast, never a rollback.
      for (const c of columns) {
        if (c.originalName && c.originalName !== c.name) {
          try {
            await api.renameJsonSchemaBindingColumn({
              connectionId,
              dbSchema: schema ?? null,
              table: desired.name,
              from: c.originalName,
              to: c.name,
            });
          } catch (e) {
            toast.error(
              t("structure.jsonSchemaRenameFailed", { message: String(e) }),
            );
          }
        }
      }
      // Refresh the explorer so the new/edited table shows immediately.
      await refreshSchema(connectionId);
      if (mode === "new") {
        closeTab(tabId);
      } else {
        // Reload the structure so the editor reflects the applied state and
        // future diffs start from the new baseline.
        const s = await api.getTableStructure(connectionId, schema, desired.name);
        currentTableNameRef.current = s.name;
        setOriginal(s);
        setColumns(s.columns.map((c) => ({ ...c, _key: nextKey() })));
        setIndexes(s.indexes);
        setForeignKeys(s.foreignKeys);
        // The table was renamed — update this tab's title (and every open
        // table-data tab for the same table) so nothing keeps showing or
        // re-fetching the old name.
        if (priorName && priorName !== s.name) {
          retitleTabsForTableRename(
            useConnections.getState().profiles,
            connectionId,
            schema,
            priorName,
            s.name,
            t("tabs.structureSuffix"),
          );
        }
      }
    } catch (e) {
      // Surface the failure both in the DDL pane and as a toast. The pane
      // alone was easy to miss (small, bottom of the tab), so a rejected DDL
      // apply — e.g. MySQL "key too long" on an oversized PK — looked like it
      // silently did nothing (issue #26).
      const message = String(e);
      setPreviewError(message);
      toast.error(t("structure.applyFailed", { message }));
    } finally {
      setApplying(false);
      setConfirmRebuild(false);
    }
  }

  function onApplyClick() {
    if (rebuild) setConfirmRebuild(true);
    else void doApply();
  }

  // ----- column row mutation helpers -----
  function patchColumn(key: string, patch: Partial<WorkingColumn>) {
    setColumns((cs) =>
      cs.map((c) => (c._key === key ? { ...c, ...patch } : c)),
    );
  }
  function addColumn() {
    setColumns((cs) => [...cs, blankColumn(defaultColumnType(typeCategories))]);
  }
  function removeColumn(key: string) {
    setColumns((cs) => cs.filter((c) => c._key !== key));
  }
  function moveColumn(key: string, direction: -1 | 1) {
    setColumns((cs) => {
      const i = cs.findIndex((c) => c._key === key);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  if (loading) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {t("structure.loading")}
      </div>
    );
  }
  if (loadError) {
    return <div className="p-4 text-xs text-destructive">{loadError}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t("structure.tableName")}
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("structure.tableNamePlaceholder")}
          className="h-7 w-64 text-xs"
          disabled={isReadOnly}
        />
        <div className="ml-auto flex items-center gap-2">
          {mode === "edit" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void reload()}
              disabled={loading || applying}
              title={t("structure.refresh")}
            >
              <RefreshCw
                className={
                  loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
                }
              />
            </Button>
          )}
          {isReadOnly ? (
            <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {ddlReadOnlyReason(driver) === "mssql"
                ? t("structure.readOnlySqlServer")
                : t("structure.readOnlyMongo")}
            </span>
          ) : (
            <Button
              size="sm"
              onClick={onApplyClick}
              disabled={applying || !name.trim() || columns.length === 0}
            >
              {applying ? t("structure.applying") : t("structure.apply")}
            </Button>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="border-b border-border px-3 py-1.5">
        <Segmented
          value={section}
          onValueChange={setSection}
          aria-label={t("structure.sectionsLabel")}
          options={(["columns", "indexes", "fks"] as const).map((s) => ({
            value: s,
            label: t(`structure.section.${s}`),
          }))}
        />
      </div>

      {/* Body: editor grids on top, DDL preview at the bottom */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {section === "columns" && (
            <ColumnsEditor
              columns={columns}
              driver={driver}
              typeCategories={typeCategories}
              // Reordering a not-yet-created table is just column array
              // order feeding one CREATE TABLE statement — every dialect
              // supports that for free. Editing a *live* table needs an
              // actual ALTER to reposition a column, which only MySQL's
              // MODIFY/ADD COLUMN … FIRST|AFTER can express.
              canReorder={mode === "new" || supportsColumnReorder(driver)}
              onPatch={patchColumn}
              onRemove={removeColumn}
              onMove={moveColumn}
              onAdd={addColumn}
              bindingContext={
                mode === "edit"
                  ? { connectionId, dbSchema: schema, table: name }
                  : undefined
              }
            />
          )}
          {section === "indexes" && (
            <>
              {/* MongoDB indexes are editable — just not here. This editor
                  diffs a `TableStructure` into DDL, and its `IndexDef` (name +
                  column names + unique) can't carry a per-key direction, a
                  TTL or a partial filter. The index manager is that surface;
                  pointing at it beats leaving the section looking inert. */}
              {supportsIndexManager(driver) && table && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("structure.indexManagerHint")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      useTabs.getState().open({
                        kind: "indexes",
                        title: `${table} (${t("tabs.indexesSuffix")})`,
                        connectionId,
                        schema,
                        table,
                      })
                    }
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    {t("structure.openIndexManager")}
                  </Button>
                </div>
              )}
              <IndexesEditor
                indexes={indexes}
                columns={columns}
                onChange={setIndexes}
              />
            </>
          )}
          {section === "fks" && (
            <ForeignKeysEditor
              fks={foreignKeys}
              columns={columns}
              onChange={setForeignKeys}
            />
          )}
        </div>

        {/* DDL preview */}
        <div className="flex h-48 flex-col border-t border-border">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            {t("structure.ddlPreview")}
            {rebuild && (
              <span className="rounded bg-warning/20 px-1.5 py-0.5 text-warning">
                {t("structure.rebuildWarning")}
              </span>
            )}
          </div>
          {previewError ? (
            <div className="px-3 py-2 text-xs text-destructive">
              {previewError}
            </div>
          ) : (
            <Editor
              height="100%"
              value={ddl}
              language="sql"
              theme={resolveMonacoTheme(editorPrefs.theme)}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                lineNumbers: "off",
                fontFamily: editorPrefs.fontFamily,
                fontSize: editorPrefs.fontSize,
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          )}
        </div>
      </div>

      {/* SQLite rebuild confirmation */}
      <Dialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("structure.rebuildTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("structure.rebuildBody")}
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRebuild(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={doApply}
              disabled={applying}
            >
              {t("structure.rebuildConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns editor
// ---------------------------------------------------------------------------

/** Shared cell chrome: a compact, bordered input matching the grid's density. */
const cellInputClass = "h-7 border-transparent bg-transparent px-1.5 text-xs shadow-none focus-visible:border-input focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Shared `<select>` chrome for the type picker. Unlike `cellInputClass`,
 * this can't stay `bg-transparent`: WebView2/Chromium paints its native
 * dropdown popup using the trigger element's own `background-color` /
 * `color`, so a transparent trigger left the open popup falling back to the
 * OS light-theme default regardless of the app's theme. `bg-background` +
 * `text-foreground` (the same pairing `BitInput` already uses for its select)
 * makes the popup match.
 */
const typeSelectClass =
  "h-7 w-full rounded-sm border border-input bg-background px-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-30";

function ColumnsEditor({
  columns,
  driver,
  typeCategories,
  canReorder,
  onPatch,
  onRemove,
  onMove,
  onAdd,
  bindingContext,
}: {
  columns: WorkingColumn[];
  driver: Driver | undefined;
  typeCategories: ColumnTypeCategory[];
  canReorder: boolean;
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onAdd: () => void;
  /**
   * Coordinates for the per-column JSON Schema affordance, or `undefined` while
   * designing a table that does not exist yet — there is nothing to anchor a
   * binding to, and writing one for a table the apply might not create would
   * leave litter behind.
   *
   * Rendered as an icon in the trailing actions cell rather than as a new column:
   * this table already carries 8–11 of them, and a twelfth would crush it.
   */
  bindingContext?: {
    connectionId: string;
    dbSchema?: string;
    table: string;
  };
}) {
  const { t } = useTranslation();
  // MySQL is the only driver where UNSIGNED/ZEROFILL are meaningful — the
  // columns are omitted entirely for the others instead of rendering
  // permanently-disabled checkboxes.
  const showUnsignedCols = supportsUnsignedIntegers(driver);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="w-9 border-b border-border px-1.5 py-1.5 font-medium">
                #
              </th>
              <th className="border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.name")}
              </th>
              <th className="w-36 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.type")}
              </th>
              <th className="w-28 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.length")}
              </th>
              {showUnsignedCols && (
                <>
                  <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                    {t("structure.col.unsigned")}
                  </th>
                  <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                    {t("structure.col.zerofill")}
                  </th>
                </>
              )}
              <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.nullable")}
              </th>
              <th className="w-12 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.pk")}
              </th>
              <th className="w-14 border-b border-border px-1 py-1.5 text-center font-medium">
                {t("structure.col.auto")}
              </th>
              <th className="w-32 border-b border-border px-1.5 py-1.5 font-medium">
                {t("structure.col.default")}
              </th>
              {bindingContext && (
                <th
                  className="w-10 border-b border-l-2 border-dashed border-border px-1 py-1.5 text-center font-medium"
                  title={t("structure.col.jsonSchemaHint")}
                >
                  {"{}"}
                </th>
              )}
              <th
                className={cn(
                  "border-b border-border",
                  canReorder ? "w-16" : "w-8",
                )}
              />
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr
                key={c._key}
                className={cn(
                  "group/col border-b border-border/50 last:border-b-0 hover:bg-accent/30",
                  i % 2 === 1 && "bg-muted/15",
                )}
              >
                <td className="px-1.5 py-0.5 tabular-nums text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {c.isPrimaryKey && (
                      <KeyRound
                        className="h-3 w-3 shrink-0 text-warning"
                        aria-label={t("structure.col.pk")}
                      />
                    )}
                    {i + 1}
                  </span>
                </td>
                <td className="px-0.5 py-0.5">
                  <Input
                    value={c.name}
                    onChange={(e) => onPatch(c._key, { name: e.target.value })}
                    placeholder={t("structure.col.namePlaceholder")}
                    className={cellInputClass}
                  />
                </td>
                <TypeCell
                  column={c}
                  categories={typeCategories}
                  onPatch={onPatch}
                />
                {showUnsignedCols && (
                  <>
                    <td className="px-1 py-0.5 text-center">
                      <UnsignedZerofillCheckbox
                        column={c}
                        categories={typeCategories}
                        field="unsigned"
                        onPatch={onPatch}
                      />
                    </td>
                    <td className="px-1 py-0.5 text-center">
                      <UnsignedZerofillCheckbox
                        column={c}
                        categories={typeCategories}
                        field="zerofill"
                        onPatch={onPatch}
                      />
                    </td>
                  </>
                )}
                <td className="px-1 py-0.5 text-center">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={c.nullable}
                    onChange={(e) =>
                      onPatch(c._key, { nullable: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={c.isPrimaryKey}
                    onChange={(e) =>
                      onPatch(c._key, { isPrimaryKey: e.target.checked })
                    }
                  />
                </td>
                <td className="px-1 py-0.5 text-center">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={!!c.autoIncrement}
                    onChange={(e) =>
                      onPatch(c._key, { autoIncrement: e.target.checked })
                    }
                  />
                </td>
                <td className="px-0.5 py-0.5">
                  <Input
                    value={c.default ?? ""}
                    onChange={(e) =>
                      onPatch(c._key, { default: e.target.value || null })
                    }
                    placeholder="—"
                    className={cn(cellInputClass, "font-mono")}
                  />
                </td>
                {bindingContext && (
                  <td className="border-l-2 border-dashed border-border px-1 py-0.5 text-center">
                    {c.name ? (
                      // Saves the instant it is picked, out of band: it is local
                      // metadata and must never enter the DDL diff below.
                      <SchemaBindingBadge
                        variant="compact"
                        language="json"
                        value=""
                        binding={{
                          connectionId: bindingContext.connectionId,
                          dbSchema: bindingContext.dbSchema,
                          table: bindingContext.table,
                          column: c.name,
                        }}
                      />
                    ) : (
                      <span
                        className="text-muted-foreground/30"
                        title={t("structure.col.jsonSchemaNewHint")}
                      >
                        —
                      </span>
                    )}
                  </td>
                )}
                <td className="px-1 py-0.5 text-center">
                  <div className="flex items-center justify-center gap-0.5 opacity-0 group-hover/col:opacity-100">
                    {canReorder && (
                      <>
                        <button
                          className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                          onClick={() => onMove(c._key, -1)}
                          disabled={i === 0}
                          title={t("structure.col.moveUp")}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                          onClick={() => onMove(c._key, 1)}
                          disabled={i === columns.length - 1}
                          title={t("structure.col.moveDown")}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => onRemove(c._key)}
                      title={t("structure.col.remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" variant="outline" onClick={onAdd}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.col.add")}
      </Button>
    </div>
  );
}

/**
 * Type + length/set cell. Splits `column.dataType` into a categorised base
 * type (a native `<select>` grouped by `<optgroup>` — HeidiSQL-style, and
 * keyboard-navigable for free) and a separate length/precision field, so
 * picking "VARCHAR" then typing "255" reads the same way the catalog
 * presents it. A `dataType` that doesn't match any catalog entry (a custom
 * or exotic type carried over from an existing table) falls back to a
 * single raw text field instead of forcing it into the picker.
 */
function TypeCell({
  column,
  categories,
  onPatch,
}: {
  column: WorkingColumn;
  categories: ColumnTypeCategory[];
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
}) {
  const { t } = useTranslation();
  const parsed = useMemo(
    () => parseColumnType(column.dataType, categories),
    [column.dataType, categories],
  );
  const selected = categories
    .flatMap((cat) => cat.types)
    .find((ty) => ty.name === parsed.baseType);

  function applyBaseType(name: string) {
    if (name === CUSTOM_TYPE_VALUE) {
      onPatch(column._key, { dataType: parsed.custom || column.dataType });
      return;
    }
    const next = categories.flatMap((cat) => cat.types).find((ty) => ty.name === name);
    onPatch(column._key, {
      dataType: composeColumnType({
        ...parsed,
        baseType: name,
        length: next?.defaultLength ?? "",
        unsigned: false,
        zerofill: false,
      }),
    });
  }

  if (!parsed.baseType) {
    // Custom/unrecognised type: one raw field, plus the picker so the user
    // can jump back into the catalog at any time.
    return (
      <>
        <td className="px-0.5 py-0.5">
          <select
            value={CUSTOM_TYPE_VALUE}
            onChange={(e) => applyBaseType(e.target.value)}
            className={typeSelectClass}
          >
            <TypeOptions categories={categories} />
          </select>
        </td>
        <td className="px-0.5 py-0.5">
          <Input
            value={column.dataType}
            onChange={(e) => onPatch(column._key, { dataType: e.target.value })}
            placeholder={t("structure.col.customTypePlaceholder")}
            className={cn(cellInputClass, "font-mono")}
          />
        </td>
      </>
    );
  }

  return (
    <>
      <td className="px-0.5 py-0.5">
        <select
          value={parsed.baseType}
          onChange={(e) => applyBaseType(e.target.value)}
          className={typeSelectClass}
        >
          <TypeOptions categories={categories} />
        </select>
      </td>
      <td className="px-0.5 py-0.5">
        <Input
          value={parsed.length}
          disabled={!selected?.hasLength}
          onChange={(e) =>
            onPatch(column._key, {
              dataType: composeColumnType({ ...parsed, length: e.target.value }),
            })
          }
          placeholder={selected?.hasLength ? selected.defaultLength ?? "" : "—"}
          className={cn(cellInputClass, "font-mono disabled:opacity-30")}
        />
      </td>
    </>
  );
}

const CUSTOM_TYPE_VALUE = "__custom__";

function TypeOptions({ categories }: { categories: ColumnTypeCategory[] }) {
  const { t } = useTranslation();
  return (
    <>
      {categories.map((cat) => (
        <optgroup key={cat.key} label={t(`structure.typeCategory.${cat.key}`)}>
          {cat.types.map((ty) => (
            <option key={ty.name} value={ty.name}>
              {ty.name}
            </option>
          ))}
        </optgroup>
      ))}
      <option value={CUSTOM_TYPE_VALUE}>{t("structure.col.customType")}</option>
    </>
  );
}

/** UNSIGNED/ZEROFILL checkbox, disabled when the selected base type doesn't
 *  carry a numeric width (e.g. TEXT, DATE) — MySQL rejects those combinations
 *  server-side, so the editor never offers them in the first place. */
function UnsignedZerofillCheckbox({
  column,
  categories,
  field,
  onPatch,
}: {
  column: WorkingColumn;
  categories: ColumnTypeCategory[];
  field: "unsigned" | "zerofill";
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
}) {
  const parsed = useMemo(
    () => parseColumnType(column.dataType, categories),
    [column.dataType, categories],
  );
  const selected = categories
    .flatMap((cat) => cat.types)
    .find((ty) => ty.name === parsed.baseType);
  const capable = !!selected?.unsignedCapable;
  return (
    <input
      type="checkbox"
      className="accent-brand disabled:opacity-30"
      disabled={!capable}
      checked={capable && parsed[field]}
      onChange={(e) =>
        onPatch(column._key, {
          dataType: composeColumnType({ ...parsed, [field]: e.target.checked }),
        })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Indexes editor
// ---------------------------------------------------------------------------

function IndexesEditor({
  indexes,
  columns,
  onChange,
}: {
  indexes: StructureIndexDef[];
  columns: WorkingColumn[];
  onChange: (next: StructureIndexDef[]) => void;
}) {
  const { t } = useTranslation();
  const colNames = columns.map((c) => c.name).filter(Boolean);
  function patch(i: number, p: Partial<StructureIndexDef>) {
    onChange(indexes.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  return (
    <div className="space-y-2">
      {indexes.map((idx, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded border border-border/50 p-2 text-xs"
        >
          <Input
            value={idx.name ?? ""}
            onChange={(e) => patch(i, { name: e.target.value || null })}
            placeholder={t("structure.idx.namePlaceholder")}
            className="h-6 w-40 text-xs"
          />
          <Input
            value={idx.columns.join(", ")}
            onChange={(e) =>
              patch(i, {
                columns: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder={colNames.join(", ")}
            className="h-6 flex-1 font-mono text-xs"
          />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="accent-brand"
              checked={idx.unique}
              onChange={(e) => patch(i, { unique: e.target.checked })}
            />
            {t("structure.idx.unique")}
          </label>
          <button
            className="text-muted-foreground/60 hover:text-destructive"
            onClick={() => onChange(indexes.filter((_, idx2) => idx2 !== i))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([...indexes, { name: null, columns: [], unique: false }])
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.idx.add")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Foreign keys editor
// ---------------------------------------------------------------------------

function ForeignKeysEditor({
  fks,
  columns,
  onChange,
}: {
  fks: ForeignKeyDef[];
  columns: WorkingColumn[];
  onChange: (next: ForeignKeyDef[]) => void;
}) {
  const { t } = useTranslation();
  const colNames = columns.map((c) => c.name).filter(Boolean);
  function patch(i: number, p: Partial<ForeignKeyDef>) {
    onChange(fks.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  const csv = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="space-y-2">
      {fks.map((fk, i) => (
        <div
          key={i}
          className="space-y-1 rounded border border-border/50 p-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <Input
              value={fk.name ?? ""}
              onChange={(e) => patch(i, { name: e.target.value || null })}
              placeholder={t("structure.fk.namePlaceholder")}
              className="h-6 w-40 text-xs"
            />
            <button
              className="ml-auto text-muted-foreground/60 hover:text-destructive"
              onClick={() => onChange(fks.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={fk.columns.join(", ")}
              onChange={(e) => patch(i, { columns: csv(e.target.value) })}
              placeholder={colNames.join(", ")}
              className="h-6 flex-1 font-mono text-xs"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              value={fk.refTable}
              onChange={(e) => patch(i, { refTable: e.target.value })}
              placeholder={t("structure.fk.refTable")}
              className="h-6 w-40 font-mono text-xs"
            />
            <Input
              value={fk.refColumns.join(", ")}
              onChange={(e) => patch(i, { refColumns: csv(e.target.value) })}
              placeholder={t("structure.fk.refColumns")}
              className="h-6 w-40 font-mono text-xs"
            />
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([
            ...fks,
            {
              name: null,
              columns: [],
              refTable: "",
              refColumns: [],
              refSchema: null,
              onDelete: null,
              onUpdate: null,
            },
          ])
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.fk.add")}
      </Button>
    </div>
  );
}
