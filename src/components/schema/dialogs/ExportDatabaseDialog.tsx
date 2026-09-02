/**
 * Connection-level / database-level "Export database…" dialog.
 *
 * Replaces the old one-click `export_database` (always the connection's one
 * implicit database, via a Rust-side save dialog) with a HeidiSQL-inspired
 * picker: checkboxes for which database(s) to include — locked to a single
 * one when opened from a specific database's own context menu, multi-select
 * when opened from the connection's — and, per checked database, which of
 * its tables (defaulting to all). A "Datos" mode picks between plain INSERTs
 * and a delete-then-insert form that survives re-running the dump against a
 * target that already has data. Everything checked lands in ONE combined
 * `.sql` file.
 *
 * Deliberately narrower than HeidiSQL's own dialog: no create/drop toggles,
 * no INSERT batch-size control, no per-table/per-database output splitting —
 * those can be added later if they turn out to matter.
 *
 * Submitting closes the dialog immediately rather than disabling it in
 * place for the export's whole duration — a `notify.progress()` card is the
 * only feedback surface from that point on, resolved into the same
 * `file`/`error` notification a foreground export would have raised anyway.
 * `export_databases` reports real row counts (`withExportProgress`, backed
 * by a `SELECT COUNT(*)` pass the backend runs before writing anything), not
 * an indeterminate spinner — the counterpart of the profile/environment
 * importers' `IMPORT_PROGRESS_EVENT`.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { notify } from "@/lib/notify";
import { baseName } from "@/lib/filePath";
import { withExportProgress } from "@/lib/bridges/export-progress-bridge";
import { ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import type { DataMode, ExportTarget, TableInfo } from "@/types";

/**
 * `"single"` — opened from a specific database's own menu (or a genuinely
 * single-DB profile's connection menu): exactly one database, not
 * removable, its `connectionId` already known (no resolution needed).
 * `"multi"` — opened from a multi-DB connection's own menu: any number of
 * `databases` may be checked; each one's connection id is resolved lazily,
 * the first time it's checked, via `openTrackedDatabaseView`.
 */
export type ExportScope =
  | { kind: "single"; connectionId: string; databaseName: string }
  | { kind: "multi"; parentId: string; databases: string[] };

interface DbRowState {
  checked: boolean;
  /** Not user-toggleable (the `"single"` scope's one row). */
  locked: boolean;
  connectionId: string | null;
  loading: boolean;
  error: string | null;
  tables: TableInfo[] | null;
  /** `null` = every table (the default); a `Set` once the user customizes. */
  selectedTables: Set<string> | null;
}

function initialState(scope: ExportScope): Record<string, DbRowState> {
  if (scope.kind === "single") {
    return {
      [scope.databaseName]: {
        checked: true,
        locked: true,
        connectionId: scope.connectionId,
        loading: false,
        error: null,
        tables: null,
        selectedTables: null,
      },
    };
  }
  const out: Record<string, DbRowState> = {};
  for (const name of scope.databases) {
    out[name] = {
      checked: false,
      locked: false,
      connectionId: null,
      loading: false,
      error: null,
      tables: null,
      selectedTables: null,
    };
  }
  return out;
}

export function ExportDatabaseDialog({
  scope,
  onClose,
}: {
  scope: ExportScope;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, DbRowState>>(() =>
    initialState(scope),
  );
  const [dataMode, setDataMode] = useState<DataMode>("insert");
  const [destPath, setDestPath] = useState("");
  // Guards against a double-fire in the brief gap between calling `submit()`
  // and the parent actually unmounting this component (`onClose()` schedules
  // that; it doesn't happen synchronously within the same click handler).
  const submittedRef = useRef(false);

  const dbNames = Object.keys(rows);
  const checkedCount = dbNames.filter((n) => rows[n].checked).length;

  function patchRow(name: string, patch: Partial<DbRowState>) {
    setRows((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }

  async function loadTables(name: string) {
    const row = rows[name];
    if (row.tables || row.loading) return;
    patchRow(name, { loading: true, error: null });
    try {
      const connectionId =
        row.connectionId ??
        (scope.kind === "multi"
          ? await openTrackedDatabaseView(scope.parentId, name)
          : scope.connectionId);
      const tables = (await api.listTables(connectionId)).filter(
        (tb) => tb.kind === "table",
      );
      patchRow(name, { connectionId, tables, loading: false });
    } catch (e) {
      patchRow(name, { loading: false, error: String(e) });
    }
  }

  function toggleDb(name: string) {
    const row = rows[name];
    if (row.locked) return;
    const next = !row.checked;
    patchRow(name, { checked: next });
    if (next) void loadTables(name);
  }

  // The `"single"` scope's one row starts out checked AND locked (the user
  // never toggles it), so `toggleDb` — the only other place that calls
  // `loadTables` — never runs for it. Without this, that row's table list
  // stayed permanently empty: not loading, not erroring, just blank, because
  // nothing had ever asked for its tables. Loads once, on mount, for any row
  // that's already checked when the dialog opens.
  useEffect(() => {
    for (const name of Object.keys(rows)) {
      if (rows[name].checked) void loadTables(name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleTable(dbName: string, tableName: string) {
    const row = rows[dbName];
    const base =
      row.selectedTables ?? new Set((row.tables ?? []).map((tb) => tb.name));
    const next = new Set(base);
    if (next.has(tableName)) next.delete(tableName);
    else next.add(tableName);
    patchRow(dbName, { selectedTables: next });
  }

  async function pickDestination() {
    const suggested =
      scope.kind === "single" ? `${scope.databaseName}.sql` : "export.sql";
    const picked = await saveFileDialog({
      title: t("schema.exportDatabaseDialog.pickTitle"),
      defaultPath: suggested,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof picked === "string" && picked) setDestPath(picked);
  }

  /**
   * Closes right away — there is nothing left in the dialog worth keeping
   * open for. The notification card is raised before `onClose()` so it is
   * already on screen the instant the dialog is gone, and the export itself
   * runs in a plain detached async function: it is not tied to this
   * component's lifecycle, so the unmount that follows doesn't interrupt it.
   */
  function submit() {
    if (checkedCount === 0 || !destPath || submittedRef.current) return;
    submittedRef.current = true;

    const handle = notify.progress(t("schema.exportDatabaseDialog.exporting"), {
      description: baseName(destPath),
      formatProgress: (p) =>
        t("schema.exportDatabaseDialog.progress", {
          done: p.done,
          total: p.total,
        }),
    });
    onClose();

    void (async () => {
      try {
        const targets: ExportTarget[] = [];
        for (const name of dbNames) {
          const row = rows[name];
          if (!row.checked) continue;
          const connectionId =
            row.connectionId ??
            (scope.kind === "multi"
              ? await openTrackedDatabaseView(scope.parentId, name)
              : scope.connectionId);
          targets.push({
            connectionId,
            databaseName: name,
            tables: row.selectedTables
              ? Array.from(row.selectedTables)
              : undefined,
          });
        }
        const path = await withExportProgress(handle.update, () =>
          api.exportDatabases({ targets, dataMode, destPath }),
        );
        handle.file(t("notifications.fileSaved.database"), { path });
      } catch (e) {
        handle.error(t("schema.exportDatabaseDialog.title"), {
          description: String(e),
        });
      }
    })();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle>{t("schema.exportDatabaseDialog.title")}</DialogTitle>
          <DialogDescription className="text-2xs">
            {t("schema.exportDatabaseDialog.description")}
          </DialogDescription>
        </DialogHeader>

        {/* Left: database/table tree (mirrors the connection manager's
            rail/editor split — a browsable tree on the left, its settings on
            the right, rather than stacking both in one column). Right:
            data-mode + destination + actions. */}
        <div className="grid flex-1 grid-cols-2 overflow-hidden">
          <aside className="min-h-0 overflow-y-auto border-r border-border p-2">
            {dbNames.map((name) => {
              const row = rows[name];
              return (
                <div key={name}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50">
                    {row.checked ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                    )}
                    <Checkbox
                      checked={row.checked}
                      disabled={row.locked}
                      onChange={() => toggleDb(name)}
                    />
                    <span className="flex-1 truncate text-xs font-medium">
                      {name}
                    </span>
                  </label>
                  {row.checked && (
                    <div className="ml-8 space-y-0.5 border-l border-border/50 pl-3">
                      {row.loading ? (
                        <p className="py-1 text-2xs text-muted-foreground">
                          {t("schema.exportDatabaseDialog.loadingTables")}
                        </p>
                      ) : row.error ? (
                        <p className="py-1 text-2xs text-destructive">
                          {row.error}
                        </p>
                      ) : (
                        row.tables?.map((tb) => {
                          const checked = row.selectedTables
                            ? row.selectedTables.has(tb.name)
                            : true;
                          return (
                            <label
                              key={tb.name}
                              className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-muted/40"
                            >
                              <Checkbox
                                size="xs"
                                checked={checked}
                                onChange={() => toggleTable(name, tb.name)}
                              />
                              <span className="truncate text-2xs text-muted-foreground">
                                {tb.name}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("schema.exportDatabaseDialog.dataMode")}
                </label>
                <Select
                  value={dataMode}
                  onValueChange={(v) => setDataMode(v as DataMode)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="insert" className="text-xs">
                      {t("schema.exportDatabaseDialog.dataModeInsert")}
                    </SelectItem>
                    <SelectItem value="truncate_insert" className="text-xs">
                      {t("schema.exportDatabaseDialog.dataModeTruncateInsert")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("schema.exportDatabaseDialog.destPath")}
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    size="sm"
                    className="min-w-0 flex-1"
                    value={destPath}
                    readOnly
                    placeholder={t(
                      "schema.exportDatabaseDialog.destPathPlaceholder",
                    )}
                    onClick={() => void pickDestination()}
                  />
                  {/* Keeps its outline: it sits against a field as its browse
                      affordance, which a borderless button would not read as. */}
                  <SimpleTooltip
                    label={t("schema.exportDatabaseDialog.browse")}
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => void pickDestination()}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            </div>

            <div className="border-t border-border px-4 py-3">
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  disabled={checkedCount === 0 || !destPath}
                  onClick={submit}
                >
                  {t("schema.exportDatabaseDialog.export")}
                </Button>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
