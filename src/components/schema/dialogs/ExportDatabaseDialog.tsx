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
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
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
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
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
  const { submitting, error, run } = useAsyncSubmit();

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
    const base = row.selectedTables ?? new Set((row.tables ?? []).map((tb) => tb.name));
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

  function submit() {
    if (checkedCount === 0 || !destPath || submitting) return;
    run(async () => {
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
          tables: row.selectedTables ? Array.from(row.selectedTables) : undefined,
        });
      }
      const path = await api.exportDatabases({ targets, dataMode, destPath });
      toast.success(t("schema.exportDatabaseDialog.success", { path }));
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle>{t("schema.exportDatabaseDialog.title")}</DialogTitle>
          <DialogDescription className="text-[11px]">
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
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50">
                    {row.checked ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                    )}
                    <input
                      type="checkbox"
                      checked={row.checked}
                      disabled={row.locked}
                      onChange={() => toggleDb(name)}
                      className="h-3.5 w-3.5 rounded accent-primary disabled:opacity-70"
                    />
                    <span className="flex-1 truncate text-xs font-medium">{name}</span>
                  </label>
                  {row.checked && (
                    <div className="ml-8 space-y-0.5 border-l border-border/50 pl-3">
                      {row.loading ? (
                        <p className="py-1 text-2xs text-muted-foreground">
                          {t("schema.exportDatabaseDialog.loadingTables")}
                        </p>
                      ) : row.error ? (
                        <p className="py-1 text-2xs text-destructive">{row.error}</p>
                      ) : (
                        row.tables?.map((tb) => {
                          const checked = row.selectedTables
                            ? row.selectedTables.has(tb.name)
                            : true;
                          return (
                            <label
                              key={tb.name}
                              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/40"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleTable(name, tb.name)}
                                className="h-3 w-3 rounded accent-primary"
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
                <Select value={dataMode} onValueChange={(v) => setDataMode(v as DataMode)}>
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
                    inputSize="sm"
                    className="min-w-0 flex-1"
                    value={destPath}
                    readOnly
                    placeholder={t("schema.exportDatabaseDialog.destPathPlaceholder")}
                    onClick={() => void pickDestination()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => void pickDestination()}
                    title={t("schema.exportDatabaseDialog.browse")}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>

            <div className="border-t border-border px-4 py-3">
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  disabled={checkedCount === 0 || !destPath || submitting}
                  onClick={submit}
                >
                  {submitting
                    ? t("schema.exportDatabaseDialog.exporting")
                    : t("schema.exportDatabaseDialog.export")}
                </Button>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
