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
import { Plus, Trash2, RefreshCw } from "lucide-react";
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
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import { resolveMonacoTheme } from "@/lib/monaco-themes";
import { columnTypesFor } from "@/lib/columnTypes";
import type {
  ColumnDef,
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

function blankColumn(): WorkingColumn {
  return {
    _key: nextKey(),
    name: "",
    originalName: null,
    dataType: "varchar(255)",
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
  // Resolve the connection's driver for the type suggestions. Synthetic
  // multi-DB ids (`<parent>::db::<db>`) inherit the parent profile's driver.
  const driver = useConnections((s) => {
    const direct = s.profiles.find((p) => p.id === connectionId);
    if (direct) return direct.driver;
    const sep = connectionId.indexOf("::db::");
    if (sep > 0) {
      return s.profiles.find((p) => p.id === connectionId.slice(0, sep))?.driver;
    }
    return undefined;
  });
  const typeSuggestions = useMemo(() => columnTypesFor(driver), [driver]);

  // MongoDB structure is read-only in this version: the backend rejects
  // preview/apply, so the editor shows the inferred fields + indexes for
  // inspection only and hides the Apply action.
  const isReadOnly = driver === "mongodb";

  const [original, setOriginal] = useState<TableStructure | null>(null);
  const [name, setName] = useState(table ?? "");
  const [columns, setColumns] = useState<WorkingColumn[]>(
    mode === "new" ? [blankColumn()] : [],
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

  // (Re)load the existing structure from the server. Runs on mount and from
  // the manual refresh button (issue #25) so external changes made while the
  // tab is open can be pulled in; a refresh resets the working state to the
  // server's current definition. The table name is fixed in edit mode, so
  // re-reading by `table` always targets the right table.
  const reload = useCallback(async () => {
    if (mode !== "edit" || !table) return;
    setLoading(true);
    try {
      const s = await api.getTableStructure(connectionId, schema, table);
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
  }, [mode, connectionId, schema, table]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
    try {
      await api.applyStructureChange({ connectionId, original, desired });
      // Refresh the explorer so the new/edited table shows immediately.
      await refreshSchema(connectionId);
      if (mode === "new") {
        closeTab(tabId);
      } else {
        // Reload the structure so the editor reflects the applied state and
        // future diffs start from the new baseline.
        const s = await api.getTableStructure(connectionId, schema, desired.name);
        setOriginal(s);
        setColumns(s.columns.map((c) => ({ ...c, _key: nextKey() })));
        setIndexes(s.indexes);
        setForeignKeys(s.foreignKeys);
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
    setColumns((cs) => [...cs, blankColumn()]);
  }
  function removeColumn(key: string) {
    setColumns((cs) => cs.filter((c) => c._key !== key));
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
          disabled={mode === "edit"}
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
              {t("structure.readOnlyMongo")}
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
              typeSuggestions={typeSuggestions}
              onPatch={patchColumn}
              onRemove={removeColumn}
              onAdd={addColumn}
            />
          )}
          {section === "indexes" && (
            <IndexesEditor
              indexes={indexes}
              columns={columns}
              onChange={setIndexes}
            />
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

function ColumnsEditor({
  columns,
  typeSuggestions,
  onPatch,
  onRemove,
  onAdd,
}: {
  columns: WorkingColumn[];
  typeSuggestions: string[];
  onPatch: (key: string, patch: Partial<WorkingColumn>) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const datalistId = "huginn-column-types";
  return (
    <div className="space-y-1">
      {/* Shared type suggestions for every row's editable type combo. */}
      <datalist id={datalistId}>
        {typeSuggestions.map((ty) => (
          <option key={ty} value={ty} />
        ))}
      </datalist>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="px-1 py-1 font-medium">{t("structure.col.name")}</th>
            <th className="px-1 py-1 font-medium">{t("structure.col.type")}</th>
            <th className="px-1 py-1 text-center font-medium">
              {t("structure.col.nullable")}
            </th>
            <th className="px-1 py-1 text-center font-medium">
              {t("structure.col.pk")}
            </th>
            <th className="px-1 py-1 text-center font-medium">
              {t("structure.col.auto")}
            </th>
            <th className="px-1 py-1 font-medium">
              {t("structure.col.default")}
            </th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c._key} className="border-t border-border/40">
              <td className="px-1 py-0.5">
                <Input
                  value={c.name}
                  onChange={(e) => onPatch(c._key, { name: e.target.value })}
                  className="h-6 text-xs"
                />
              </td>
              <td className="px-1 py-0.5">
                <Input
                  value={c.dataType}
                  list={datalistId}
                  onChange={(e) =>
                    onPatch(c._key, { dataType: e.target.value })
                  }
                  className="h-6 font-mono text-xs"
                />
              </td>
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
              <td className="px-1 py-0.5">
                <Input
                  value={c.default ?? ""}
                  onChange={(e) =>
                    onPatch(c._key, { default: e.target.value || null })
                  }
                  placeholder="—"
                  className="h-6 font-mono text-xs"
                />
              </td>
              <td className="px-1 py-0.5 text-center">
                <button
                  className="text-muted-foreground/60 hover:text-destructive"
                  onClick={() => onRemove(c._key)}
                  title={t("structure.col.remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button size="sm" variant="outline" onClick={onAdd} className="mt-2">
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("structure.col.add")}
      </Button>
    </div>
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
