/**
 * Tree-style explorer of databases / schemas / tables / columns for the
 * currently selected connection. Columns are lazy-loaded the first time
 * a table node is expanded. Single-click on a table opens it in a data tab.
 *
 * Tree structure (single-DB profile):
 *   schema
 *   ├─ tables  (expandable section)
 *   │   ├─ table_name  <row_count>
 *   │   │   └─ column_name  TYPE
 *   │   └─ …
 *   ├─ views   (expandable section)
 *   └─ indexes (expandable section — headers only for now)
 *
 * Multi-DB mode (profile.database === ""):
 *   database
 *   ├─ <schema subtree, same as single-DB mode>
 *   └─ …
 *
 * In multi-DB mode each database expansion opens a synthetic
 * `<parentId>::db::<db>` connection in the backend (see
 * `open_database_view`), and every nested node uses that synthetic id so
 * downstream commands like `list_tables` / `fetch_table_data` keep their
 * existing single-connection-id signatures.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Plus,
  RefreshCw,
  Table as TableIcon,
  Eye,
  KeyRound,
  LayoutList,
  ListChecks,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useSchema, tableKey } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { tableTabTitle } from "@/lib/connectionLabel";
import { usePreferences } from "@/stores/preferences";
import { api } from "@/lib/tauri";
import { toast } from "sonner";
import { splitSql } from "@/lib/sqlSplit";
import type { SchemaTableMetric } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { confirmDestructive } from "@/lib/confirmDestructive";
import type { Driver, TableInfo } from "@/types";

/**
 * Match a table/database name against the filter box. HeidiSQL-style: the
 * filter may hold several `;`-separated patterns and a name matches when it
 * contains ANY of them (OR), so `users; orders` surfaces both tables at once.
 * An empty filter (or one that's only separators/whitespace) matches all.
 */
/** Open (or focus, if already open) the "Security" tab for `connectionId`. */
function openSecurityTab(connectionId: string, title: string) {
  useTabs.getState().open({
    kind: "security",
    title,
    connectionId,
  });
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Export `connectionId`'s target database to a user-chosen `.sql` file and
 *  toast the outcome. A cancelled save dialog is a silent no-op, not an error. */
async function exportDatabaseWithToast(connectionId: string, t: Translate) {
  try {
    const path = await api.exportDatabase(connectionId);
    toast.success(t("schema.exportDatabase.success", { path }));
  } catch (e) {
    const message = String(e);
    if (!message.includes("export cancelled")) toast.error(message);
  }
}

/** Pick a `.sql` file, confirm, and run it through the existing batch runner
 *  (`splitSql` + `executeBatch`) against `connectionId` — the same runner the
 *  query editor uses, so import gets no separate execution path. Returns
 *  `false` if the user cancelled the picker/confirmation or the file held no
 *  statements, `true` once a batch actually ran (regardless of per-statement
 *  outcome — failures are toasted, not thrown). */
async function importSqlFile(connectionId: string, t: Translate): Promise<boolean> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: t("schema.importSql.pickTitle"),
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  if (typeof picked !== "string" || !picked) return false;
  const text = await api.readTextFile(picked);
  const statements = splitSql(text);
  if (statements.length === 0) return false;
  if (
    !confirmDestructive(
      t("schema.importSql.confirm", { count: statements.length }),
    )
  ) {
    return false;
  }
  const result = await api.executeBatch(
    connectionId,
    statements.map((s) => s.text),
  );
  const failed = result.statements.find((s) => s.error);
  if (failed) {
    toast.error(
      t("schema.importSql.failed", {
        index: failed.index + 1,
        message: failed.error,
      }),
    );
  } else {
    toast.success(
      t("schema.importSql.success", { count: result.statements.length }),
    );
  }
  return true;
}

function matchesFilter(name: string, filter: string): boolean {
  const patterns = filter
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const n = name.toLowerCase();
  return patterns.some((p) => n.includes(p));
}

/**
 * Coarse colour for a column's data type, tying the tree's type labels to the
 * grid's semantic hues: numeric → `numeric` (the same amber as numeric cells),
 * boolean → `success`, everything else stays muted. Deliberately restrained —
 * a full per-family palette would need dedicated tokens; this reuses what the
 * grid already establishes so the two surfaces read as one system.
 */
function typeColorClass(dataType: string): string {
  const d = dataType.toLowerCase();
  if (/(int|serial|numeric|decimal|real|double|float|money|bit|number)/.test(d))
    return "text-numeric";
  if (/bool/.test(d)) return "text-success";
  return "text-muted-foreground/70";
}

/** Shimmer placeholder rows shown while a table's columns load, instead of a
 *  bare italic "loading…" line — reads as an active fetch rather than a stall.
 *  Keeps the original label as the accessible status text. */
function ColumnSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-1 py-1" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-2.5 animate-pulse rounded bg-muted-foreground/15"
          style={{ width: `${70 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

export function SchemaExplorer({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  // Multi-DB mode triggers when the parent profile has no `database` set
  // (e.g. the user wants to browse every database on the server). SQLite
  // profiles are inherently single-file, so they never enter this mode.
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isMultiDb =
    !!profile && profile.driver !== "sqlite" && profile.database === "";

  if (isMultiDb) {
    return <MultiDbExplorer parentId={connectionId} />;
  }
  return <SingleDbExplorer connectionId={connectionId} title={t("schema.title")} />;
}

// ---------------------------------------------------------------------------
// Single-database explorer (used directly for profiles with `database` set,
// and as the inner subtree of each database node in multi-DB mode).
// ---------------------------------------------------------------------------

function SingleDbExplorer({
  connectionId,
  title,
  headerLevel = "root",
  controlledFilter,
  onTableOpen,
}: {
  connectionId: string;
  title: string;
  /**
   * `root` shows the standard "SCHEMA" header + refresh button. `nested`
   * skips the header chrome entirely — used when this subtree lives under a
   * database node and the outer multi-DB explorer already owns the chrome.
   */
  headerLevel?: "root" | "nested";
  /**
   * When provided, the filter is owned by a parent component (typically
   * [[MultiDbExplorer]], which renders one filter input shared across all
   * DBs). The local input is hidden and the local state is bypassed —
   * propagated by the parent so every nested DB filters by the same
   * needle, which was the whole point of the multi-DB unification.
   */
  controlledFilter?: string;
  /**
   * Optional callback fired when the user opens a table (click or context
   * menu). Used by the multi-DB parent to activate this database's scope
   * and collapse the others.
   */
  onTableOpen?: () => void;
}) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  const loadColumns = useSchema((s) => s.loadColumns);
  const openTab = useTabs((s) => s.open);

  // Driver lookup: needed by the context menu to compose a driver-correct
  // "Copy SELECT" snippet. For synthetic multi-DB connection ids the
  // profile lives under the parent half of the id.
  const driver = useConnections((s) => {
    const direct = s.profiles.find((p) => p.id === connectionId);
    if (direct) return direct.driver;
    const sep = connectionId.indexOf("::db::");
    if (sep > 0) {
      const parent = s.profiles.find((p) => p.id === connectionId.slice(0, sep));
      if (parent) return parent.driver;
    }
    return undefined;
  });

  // When the filter is owned by the parent we ignore the local state and
  // hide the local input. We still declare the local state to keep the
  // hook order stable when toggling between controlled and uncontrolled
  // (the prop being defined/undefined doesn't change between renders in
  // practice — a `<DatabaseRoot>` is either inside a multi-DB tree or it
  // isn't — but defending against future restructures is cheap).
  const [localFilter, setLocalFilter] = useState("");
  const isControlled = controlledFilter !== undefined;
  const filter = isControlled ? controlledFilter : localFilter;
  const setFilter = isControlled ? () => {} : setLocalFilter;

  const [renameTarget, setRenameTarget] = useState<TableInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<TableInfo | null>(null);
  const [emptyTarget, setEmptyTarget] = useState<TableInfo | null>(null);
  const [renameViewTarget, setRenameViewTarget] = useState<TableInfo | null>(
    null,
  );
  const [dropViewTarget, setDropViewTarget] = useState<TableInfo | null>(null);
  // Same rationale as `MultiDbExplorer`'s "+" button (see `create_database`'s
  // doc comment): server-level DDL, Postgres/MySQL only. Offered here too —
  // a profile scoped to one specific database is at least as common as
  // multi-DB browsing, and there's no reason someone connected that way
  // can't add a sibling database on the same server.
  const canCreateDatabase = driver === "postgres" || driver === "mysql";
  const [createDbOpen, setCreateDbOpen] = useState(false);
  // MongoDB has no CREATE DATABASE, but it does have an explicit
  // create-collection (#61) — offered here so a single-DB Mongo profile (or
  // a per-database view) can add an empty collection without inserting first.
  const canCreateCollection = driver === "mongodb";
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);

  useEffect(() => {
    // Fire refresh only when no successful fetch has happened yet AND no
    // fetch is currently in flight. Without the `!cs.loading` guard, every
    // `set({ loading: true })` call inside `refresh` would create a new `cs`
    // reference, re-trigger this effect, and launch a second concurrent fetch
    // before the first one finishes — a tight loop on slow drivers (MySQL).
    if (!cs || (!cs.initialized && !cs.loading)) refresh(connectionId);
  }, [connectionId, cs, refresh]);

  // Group tables by schema, then by kind within each schema. Apply the
  // filter at this stage so empty schemas drop out of the rendered list
  // entirely when nothing matches.
  //
  // This hook MUST stay above the `if (!cs)` early return below. When a
  // multi-DB filter is cleared, several nested explorers unmount while
  // `byConnection` is still settling, and `cs` can flip to `undefined` for
  // a render before the slice reappears. A `useMemo` placed *after* the
  // early return would then be skipped on the `undefined` render and called
  // again on the next one — "rendered fewer hooks than expected", which
  // crashed the whole connection panel to a blank screen (the exact 1.0.1
  // multi-DB blank-panel bug). Keeping it here, reading `cs?.tables`, makes
  // the hook count constant. Memoising also keeps the grouping object
  // reference-stable so the `TableSection` subtree doesn't thrash on every
  // render of the surviving explorers (CLAUDE.md gotcha #1).
  const needle = filter.trim().toLowerCase();
  const { bySchema, schemas } = useMemo(() => {
    const grouped: Record<
      string,
      { tables: TableInfo[]; views: TableInfo[] }
    > = {};
    for (const tbl of cs?.tables ?? []) {
      if (needle && !matchesFilter(tbl.name, needle)) continue;
      grouped[tbl.schema] ??= { tables: [], views: [] };
      if (tbl.kind === "view") {
        grouped[tbl.schema].views.push(tbl);
      } else {
        grouped[tbl.schema].tables.push(tbl);
      }
    }
    return { bySchema: grouped, schemas: Object.keys(grouped).sort() };
  }, [cs?.tables, needle]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  const wrappedOpenTab: typeof openTab = onTableOpen
    ? (config) => { onTableOpen(); return openTab(config); }
    : openTab;

  const tableActions: TableActions = {
    openTab: wrappedOpenTab,
    refresh: () => refresh(connectionId),
    onRename: (tbl) => setRenameTarget(tbl),
    onDrop: (tbl) => setDropTarget(tbl),
    onEmpty: (tbl) => {
      // "Don't ask again" (#69): when the user has silenced the prompt, empty
      // straight away; otherwise route through the confirmation dialog. This
      // is a dedicated preference, not the global `confirmDestructive`, so
      // opting out here never weakens other destructive confirmations.
      if (usePreferences.getState().prefs.ui.confirmEmptyTable) {
        setEmptyTarget(tbl);
        return;
      }
      void (async () => {
        try {
          await api.emptyTable(connectionId, tbl.schema, tbl.name);
          toast.success(t("schema.empty.emptied", { name: tbl.name }));
          refresh(connectionId);
        } catch (e) {
          toast.error(String(e));
        }
      })();
    },
    onRenameView: (tbl) => setRenameViewTarget(tbl),
    onDropView: (tbl) => setDropViewTarget(tbl),
    driver,
  };

  return (
    <div className="flex h-full flex-col">
      {headerLevel === "root" && (
        <div className="flex items-center justify-between px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </div>
          <div className="flex items-center gap-0.5">
            {canCreateDatabase && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setCreateDbOpen(true)}
                title={t("schema.createDatabase.title")}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
            {canCreateCollection && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setCreateCollectionOpen(true)}
                title={t("schema.createCollection.title")}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Whole-database .sql export/import is SQL-only; MongoDB uses the
                per-collection JSON export/import in the collection menu (#65). */}
            {!canCreateCollection && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void exportDatabaseWithToast(connectionId, t)}
                  title={t("schema.exportDatabase.title")}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    void importSqlFile(connectionId, t).then((ran) => {
                      if (ran) refresh(connectionId);
                    })
                  }
                  title={t("schema.importSql.title")}
                >
                  <Upload className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => openSecurityTab(connectionId, t("security.title"))}
              title={t("security.title")}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => refresh(connectionId)}
              disabled={cs.loading}
              title={t("schema.refresh")}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
      )}
      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={connectionId}
          onClose={() => setCreateDbOpen(false)}
          onDone={(name) => {
            setCreateDbOpen(false);
            refresh(connectionId);
            // This connection is scoped to one database, so there's no
            // visible database list here for the user to notice updated —
            // unlike the multi-DB toolbar's "+", where the new node
            // appearing in the tree IS the confirmation.
            toast.success(t("schema.createDatabase.createdSingleDb", { name }));
          }}
        />
      )}
      {createCollectionOpen && (
        <CreateCollectionDialog
          connectionId={connectionId}
          onClose={() => setCreateCollectionOpen(false)}
          onDone={(name) => {
            setCreateCollectionOpen(false);
            refresh(connectionId);
            toast.success(t("schema.createCollection.created", { name }));
          }}
        />
      )}
      {!isControlled && (
        <div className="px-3 pb-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("schema.filterPlaceholder")}
            className="h-7 text-xs"
          />
        </div>
      )}
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {needle && schemas.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {(() => {
          // In multi-DB mode, MySQL and SQLite synthetic children report
          // every table under a single "schema" name that coincides with
          // the database name itself (`SELECT DATABASE()` on MySQL,
          // hard-coded "main" on SQLite). Re-rendering that as a Database
          // node under the database we just expanded looks like the
          // database is nested inside itself. When this nested explorer
          // sees exactly one schema, drop the redundant header and pin
          // the sections directly under the parent DB node. Postgres
          // multi-DB legitimately has multiple user schemas
          // (`public`, custom namespaces) — there we keep the per-schema
          // header so they remain distinguishable.
          const flattenSingleSchema =
            headerLevel === "nested" && schemas.length === 1;
          return schemas.map((schema) => {
            const schemaNodeKey = `schema:${schema}`;
            // Force-expand a schema when the filter is active so matching
            // tables under it are visible without the user having to click.
            const schemaOpen =
              flattenSingleSchema || needle
                ? true
                : cs.expanded.has(schemaNodeKey);
            const { tables, views } = bySchema[schema];

            return (
              <div key={schema}>
                {/* Schema / database header — suppressed when we're a
                    nested explorer with a single schema to avoid a
                    duplicate database node (see comment above). */}
                {!flattenSingleSchema && (
                  <button
                    className="flex w-full items-center gap-1 px-2 py-1 hover:bg-accent/40"
                    onClick={() => toggleNode(connectionId, schemaNodeKey)}
                  >
                    {schemaOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <Database className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate text-xs">{schema}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {tables.length + views.length}
                    </span>
                  </button>
                )}

                {schemaOpen && (
                  <div>
                    {/* Tables section */}
                    <TableSection
                      label={t("schema.sectionTables")}
                      icon={<TableIcon className="h-3 w-3 text-muted-foreground/70" />}
                      items={tables}
                      sectionKey={`${schemaNodeKey}:tables`}
                      connectionId={connectionId}
                      cs={cs}
                      toggleNode={toggleNode}
                      loadColumns={loadColumns}
                      actions={tableActions}
                      forceOpen={!!needle}
                    />

                    {/* Views section */}
                    {views.length > 0 && (
                      <TableSection
                        label={t("schema.sectionViews")}
                        icon={<Eye className="h-3 w-3 text-muted-foreground/70" />}
                        items={views}
                        sectionKey={`${schemaNodeKey}:views`}
                        connectionId={connectionId}
                        cs={cs}
                        toggleNode={toggleNode}
                        loadColumns={loadColumns}
                        actions={tableActions}
                        forceOpen={!!needle}
                      />
                    )}

                    {/* Indexes section header — content is per-table */}
                    <IndexesSectionHeader
                      label={t("schema.sectionIndexes")}
                      sectionKey={`${schemaNodeKey}:indexes`}
                      connectionId={connectionId}
                      expanded={cs.expanded}
                      toggleNode={toggleNode}
                    />
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>

      {renameTarget && (
        <RenameTableDialog
          connectionId={connectionId}
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {dropTarget && (
        <DropTableDialog
          connectionId={connectionId}
          target={dropTarget}
          onClose={() => setDropTarget(null)}
          onDone={() => {
            setDropTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {emptyTarget && (
        <EmptyTableDialog
          connectionId={connectionId}
          target={emptyTarget}
          onClose={() => setEmptyTarget(null)}
          onDone={() => {
            setEmptyTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {renameViewTarget && (
        <RenameViewDialog
          connectionId={connectionId}
          target={renameViewTarget}
          onClose={() => setRenameViewTarget(null)}
          onDone={() => {
            setRenameViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {dropViewTarget && (
        <DropViewDialog
          connectionId={connectionId}
          target={dropViewTarget}
          onClose={() => setDropViewTarget(null)}
          onDone={() => {
            setDropViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-DB explorer — for profiles whose `database` is blank. Lists every
// database the user can see on the server as a top-level node; expanding
// one lazily opens a synthetic connection (`open_database_view`) and the
// nested subtree behaves like a regular single-DB explorer pointed at that
// synthetic id.
// ---------------------------------------------------------------------------

function MultiDbExplorer({ parentId }: { parentId: string }) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[parentId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  // CREATE DATABASE is server-level DDL, only meaningful for Postgres/MySQL —
  // SQLite never reaches multi-DB mode at all, and MongoDB creates databases
  // implicitly on first write (see `create_database`'s doc comment).
  // The whole profile: we need the driver AND the visible-databases subset
  // (#64). `find` returns the existing object ref (stable until `profiles` is
  // replaced), so this is a safe selector (gotcha #1 forbids fresh arrays/
  // objects, not existing refs).
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === parentId),
  );
  const driver = profile?.driver;
  const canCreateDatabase = driver === "postgres" || driver === "mysql";
  const [createDbOpen, setCreateDbOpen] = useState(false);
  // DataGrip-style visible-databases subset. `null`/empty = show all.
  const visibleDatabases = profile?.visible_databases ?? null;
  const visibleSet = useMemo(
    () =>
      visibleDatabases && visibleDatabases.length > 0
        ? new Set(visibleDatabases)
        : null,
    [visibleDatabases],
  );
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  // Subscribe to the whole map so `matchingDbs` reactively recomputes
  // as each prefetch lands. The membership check is cheap (Map lookup
  // per database) so the broader subscription is fine here.
  const byConnection = useSchema((s) => s.byConnection);

  // The database the user is currently focused on (last expanded or last
  // table clicked). When set, the filter scopes to this DB only — same
  // model as HeidiSQL. null → search across all DBs (retrocompat).
  const [activeDatabaseName, setActiveDatabaseName] = useState<string | null>(null);

  // Connection-level filter, shared across every database in the
  // explorer. Lifted up here so multi-DB connections have a single
  // search box instead of one per database — see plan A2. Each nested
  // SingleDbExplorer receives this value via `controlledFilter` and
  // hides its own input.
  const [filter, setFilter] = useState("");

  // Debounced needle drives the prefetch fan-out and the
  // matching-database computation. Without the delay, every keystroke
  // would queue an `openDatabaseView` + `list_tables` against every
  // database on the server.
  const [debouncedNeedle, setDebouncedNeedle] = useState("");
  useEffect(() => {
    const trimmed = filter.trim().toLowerCase();
    // Skip debouncing the empty case — clearing the filter should feel
    // instantaneous so the user immediately gets the full list back.
    if (trimmed.length === 0) {
      setDebouncedNeedle("");
      return;
    }
    const id = setTimeout(() => setDebouncedNeedle(trimmed), 250);
    return () => clearTimeout(id);
  }, [filter]);

  useEffect(() => {
    if (!cs || (!cs.initialized && !cs.loading)) refresh(parentId);
  }, [parentId, cs, refresh]);

  // No eager warm on connect: with many databases (a server with 19+ is
  // common) precaching every child's table list made the initial load
  // noticeably slow, and the DataGrip-style visible-databases selector (#64)
  // plus lazy expand already give the user control over what actually loads.
  // Databases now load only when expanded, or on demand while searching
  // (below). The first cross-database search is therefore "cold" — an
  // acceptable trade for an instant connect.

  // On-demand prefetch while searching: walk every database we haven't loaded
  // yet, open the synthetic child connection, and pull its table list into the
  // store so the cross-database match set fills in. We mark a db as
  // "in-flight" the moment we start so concurrent renders don't schedule it
  // twice. Failures are swallowed — the matching computation just won't include
  // that DB until the user retries. Limit to needle length >= 2 to avoid a full
  // fan-out on a single typed character, and scope to the active/visible set.
  const inFlightPrefetch = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (debouncedNeedle.length < 2 || !cs) return;
    // When a database is active, only prefetch that one — avoids a full
    // fan-out across every database on large servers during scoped searches.
    const dbsToWarm = (
      activeDatabaseName
        ? cs.databases.filter((db) => db.name === activeDatabaseName)
        : cs.databases
    ).filter((db) => !visibleSet || visibleSet.has(db.name));
    for (const db of dbsToWarm) {
      const childId = `${parentId}::db::${db.name}`;
      const childCs = byConnection[childId];
      if (childCs?.initialized || childCs?.loading) continue;
      if (inFlightPrefetch.current.has(childId)) continue;
      inFlightPrefetch.current.add(childId);
      api
        .openDatabaseView(parentId, db.name)
        .then((resolvedId) => refresh(resolvedId))
        .catch(() => {
          // Silent: a failed prefetch is reported via the database's
          // own subtree the next time the user expands it.
        })
        .finally(() => {
          inFlightPrefetch.current.delete(childId);
        });
    }
  }, [
    debouncedNeedle,
    cs,
    byConnection,
    parentId,
    refresh,
    activeDatabaseName,
    visibleSet,
  ]);

  const filterActive = debouncedNeedle.length > 0;

  // Decide which databases to render. With an active filter we surface
  // (a) DBs whose own catalog name matches the needle (covers the case
  // where the user is looking for a database by name), and (b) DBs that
  // own at least one matching table — those auto-expand so the user
  // sees the matches without an extra click.
  //
  // This memo MUST live above the early return below: React relies on
  // hooks being called in the same order on every render, so a
  // conditional `if (!cs) return …` above this useMemo would skip the
  // hook on the first render and call it on subsequent ones — a Rules
  // of Hooks violation that blanked the whole multi-DB panel in 0.7.0
  // / 0.7.1 (no error UI, just an empty tree). See CLAUDE.md for the
  // broader family of cases (selectors / refs / memos slipping below
  // an early return).
  const matchingDbs = useMemo(() => {
    if (!filterActive || !cs) return null;
    const m = new Map<string, { byName: boolean; byTable: boolean }>();
    // Scope to the active database when one is set; otherwise search all.
    const dbsToSearch = activeDatabaseName
      ? cs.databases.filter((db) => db.name === activeDatabaseName)
      : cs.databases;
    for (const db of dbsToSearch) {
      const childId = `${parentId}::db::${db.name}`;
      const tables = byConnection[childId]?.tables ?? [];
      const byTable = tables.some((t) =>
        matchesFilter(t.name, debouncedNeedle),
      );
      const byName = matchesFilter(db.name, debouncedNeedle);
      if (byName || byTable) m.set(db.name, { byName, byTable });
    }
    return m;
  }, [filterActive, debouncedNeedle, cs, byConnection, parentId, activeDatabaseName]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  // Activating a DB from a table click: sets the active scope AND
  // collapses any other expanded databases so only the target remains open.
  const activateDb = (dbName: string) => {
    setActiveDatabaseName(dbName);
    for (const key of cs.expanded) {
      if (key.startsWith("db:") && key !== `db:${dbName}`) {
        toggleNode(parentId, key);
      }
    }
  };

  // While prefetches are in flight we want to tell the user something
  // is happening — "no matches" would be misleading if the DBs simply
  // haven't reported yet.
  const prefetching =
    filterActive &&
    cs.databases.some((db) => {
      const childId = `${parentId}::db::${db.name}`;
      const c = byConnection[childId];
      return !c?.initialized;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("schema.title")}
        </div>
        <div className="flex items-center gap-0.5">
          {canCreateDatabase && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setCreateDbOpen(true)}
              title={t("schema.createDatabase.title")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setDbPickerOpen(true)}
            title={t("schema.selectDatabases.title")}
          >
            <ListChecks
              className={cn(
                "h-3.5 w-3.5",
                // Brand-tint the icon when a subset is active so it's obvious
                // some databases are hidden.
                visibleSet ? "text-brand" : undefined,
              )}
            />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => openSecurityTab(parentId, t("security.title"))}
            title={t("security.title")}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => refresh(parentId)}
            disabled={cs.loading}
            title={t("schema.refresh")}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>
      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={parentId}
          onClose={() => setCreateDbOpen(false)}
          onDone={() => {
            setCreateDbOpen(false);
            refresh(parentId);
          }}
        />
      )}
      {dbPickerOpen && (
        <DatabaseVisibilityDialog
          profileId={parentId}
          databases={cs.databases.map((db) => db.name)}
          selected={visibleDatabases}
          onClose={() => setDbPickerOpen(false)}
        />
      )}
      <div className="px-3 pb-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={
            activeDatabaseName
              ? t("schema.filterInDb", { db: activeDatabaseName })
              : t("schema.filterPlaceholder")
          }
          className="h-7 text-xs"
        />
        {activeDatabaseName && filterActive && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t("schema.filterScopedTo", { db: activeDatabaseName })}
          </div>
        )}
      </div>
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {filterActive && matchingDbs && matchingDbs.size === 0 && !prefetching && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {cs.databases
          .filter((db) => !visibleSet || visibleSet.has(db.name))
          .filter((db) => !matchingDbs || matchingDbs.has(db.name))
          .map((db) => {
            const match = matchingDbs?.get(db.name);
            // Auto-expand DBs that contain a table match so the result
            // is visible immediately. A name-only match keeps the DB
            // collapsed — the user is presumably picking the database,
            // not browsing inside it.
            const autoExpand = !!match?.byTable;
            return (
              <DatabaseRoot
                key={`${parentId}::${db.name}`}
                parentId={parentId}
                dbName={db.name}
                driver={driver}
                canDrop={canCreateDatabase}
                expanded={cs.expanded.has(`db:${db.name}`)}
                onToggle={() => toggleNode(parentId, `db:${db.name}`)}
                onActivate={(name) => setActiveDatabaseName(name)}
                onTableOpen={() => activateDb(db.name)}
                filter={filter}
                filterActive={filterActive}
                autoExpand={autoExpand}
                active={activeDatabaseName === db.name}
                // Only dim siblings when a concrete DB is active. With no
                // active DB the filter spans every database, so they're all
                // equally "in play" — dimming would be misleading.
                dimmed={activeDatabaseName != null && activeDatabaseName !== db.name}
              />
            );
          })}
      </div>
    </div>
  );
}

/** One database row in the multi-DB explorer. Lazily opens the synthetic
 *  child pool the first time it is expanded; subsequent expansions reuse
 *  it. */
function DatabaseRoot({
  parentId,
  dbName,
  driver,
  canDrop,
  expanded,
  onToggle,
  onActivate,
  onTableOpen,
  filter,
  filterActive,
  autoExpand,
  active,
  dimmed,
}: {
  parentId: string;
  dbName: string;
  /** Parent connection's driver — gates the Mongo-only "New collection" entry. */
  driver: Driver | undefined;
  /** Whether `DROP DATABASE` is offered (Postgres/MySQL only). */
  canDrop: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Called when the user expands/collapses this DB via the chevron. */
  onActivate: (dbName: string | null) => void;
  /** Called when the user opens a table inside this DB. */
  onTableOpen: () => void;
  /** Shared connection-level filter, forwarded to the nested explorer. */
  filter: string;
  /** True when the parent filter has any content; auto-expands already-opened
   *  databases so search results surface without an extra click. */
  filterActive: boolean;
  /** True when the parent has determined this DB contains a table match
   *  for the current filter — auto-opens the subtree (Compass-style). */
  autoExpand?: boolean;
  /** True when this is the DB the filter is scoped to (brand marker). */
  active: boolean;
  /** True when *another* DB is the active scope — render this one dimmed. */
  dimmed: boolean;
}) {
  const { t } = useTranslation();
  const [childId, setChildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  /** The `<parent>::db::<db>` view id the create-collection dialog targets;
   *  non-null while the dialog is open (#61). */
  const [createCollectionId, setCreateCollectionId] = useState<string | null>(
    null,
  );

  // "New query here": open a query tab scoped to *this* database. We must run
  // it against the synthetic `<parentId>::db::<db>` pool, so if the subtree was
  // never expanded (no `childId` yet) we open the database view first to obtain
  // that id — the same call the expand effect makes.
  const openQueryHere = async () => {
    let id = childId;
    if (!id) {
      try {
        id = await api.openDatabaseView(parentId, dbName);
        setChildId(id);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    useTabs.getState().open({
      kind: "query",
      title: t("tabs.queryFileName"),
      connectionId: id,
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  };

  // "Security": same lazy-open-then-navigate pattern as `openQueryHere`,
  // scoped to this database's synthetic connection id.
  const openSecurityHere = async () => {
    let id = childId;
    if (!id) {
      try {
        id = await api.openDatabaseView(parentId, dbName);
        setChildId(id);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    openSecurityTab(id, t("security.title"));
  };

  // Export / import: same lazy-open-then-use pattern as `openQueryHere`,
  // scoped to this database's synthetic connection id.
  const exportThisDatabase = async () => {
    let id = childId;
    if (!id) {
      try {
        id = await api.openDatabaseView(parentId, dbName);
        setChildId(id);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    await exportDatabaseWithToast(id, t);
  };

  const importSqlHere = async () => {
    let id = childId;
    if (!id) {
      try {
        id = await api.openDatabaseView(parentId, dbName);
        setChildId(id);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    if (await importSqlFile(id, t)) await useSchema.getState().refresh(id);
  };

  // "New collection" (MongoDB): lazily resolve this database's synthetic view
  // id (same pattern as the handlers above) and open the create dialog scoped
  // to it. `create_collection` needs a pool bound to this specific database.
  const createCollectionHere = async () => {
    let id = childId;
    if (!id) {
      try {
        id = await api.openDatabaseView(parentId, dbName);
        setChildId(id);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    setCreateCollectionId(id);
  };

  // Drop this database (Postgres/MySQL). Irreversible, so it's gated behind
  // the typed-confirmation prompt. On success we tear down the child pool's
  // frontend state (its schema slice + any open tabs) and refresh the parent
  // tree so the row disappears; the backend already closed the child pool.
  const dropThisDatabase = async () => {
    if (!confirmDestructive(t("schema.dropDatabase.confirm", { name: dbName })))
      return;
    try {
      await api.dropDatabase(parentId, dbName);
      const childId = `${parentId}::db::${dbName}`;
      useTabs.getState().closeForConnection(childId);
      useSchema.getState().drop(childId);
      await useSchema.getState().refresh(parentId);
    } catch (e) {
      setError(String(e));
    }
  };

  // Three ways the subtree can be open:
  //   1. The user clicked the chevron (`expanded`).
  //   2. The user is searching and the DB was already opened earlier
  //      (`filterActive && childId`).
  //   3. The Compass-style filter has determined this DB has matching
  //      tables and asks us to auto-open it (`autoExpand`).
  const effectiveExpanded =
    expanded || autoExpand || (filterActive && childId !== null);

  useEffect(() => {
    if (!effectiveExpanded || childId || opening) return;
    setOpening(true);
    setError(null);
    api
      .openDatabaseView(parentId, dbName)
      .then((id) => setChildId(id))
      .catch((e) => setError(String(e)))
      .finally(() => setOpening(false));
  }, [effectiveExpanded, childId, opening, parentId, dbName]);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              "flex w-full items-center gap-1 px-2 py-1 transition-opacity hover:bg-accent/40",
              dimmed && "opacity-50 hover:opacity-100",
            )}
            onClick={() => {
              onToggle();
              // `expanded` reflects the state *before* this click:
              // true → user is collapsing → clear active scope.
              // false → user is expanding → set this DB as active.
              onActivate(expanded ? null : dbName);
            }}
          >
            {effectiveExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            {/* Always reserve the dot's width so names don't shift when a DB
                becomes the active scope; only the active one is coloured. */}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                active ? "bg-brand" : "bg-transparent",
              )}
            />
            <Database
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                active ? "text-brand" : "text-muted-foreground",
              )}
            />
            <span className="truncate text-xs">{dbName}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void openQueryHere()}>
            {t("schema.context.newQueryHere")}
          </ContextMenuItem>
          {driver === "mongodb" && (
            <ContextMenuItem onSelect={() => void createCollectionHere()}>
              {t("schema.createCollection.title")}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void openSecurityHere()}>
            {t("security.title")}
          </ContextMenuItem>
          {/* Whole-database .sql export/import is SQL-only; MongoDB databases
              use the per-collection JSON export/import instead (#65). */}
          {driver !== "mongodb" && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void exportThisDatabase()}>
                {t("schema.exportDatabase.title")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void importSqlHere()}>
                {t("schema.importSql.title")}
              </ContextMenuItem>
            </>
          )}
          {canDrop && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => void dropThisDatabase()}
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              >
                {t("schema.context.dropDatabase")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {createCollectionId && (
        <CreateCollectionDialog
          connectionId={createCollectionId}
          onClose={() => setCreateCollectionId(null)}
          onDone={(name) => {
            const id = createCollectionId;
            setCreateCollectionId(null);
            if (id) void useSchema.getState().refresh(id);
            toast.success(t("schema.createCollection.created", { name }));
          }}
        />
      )}
      {effectiveExpanded && (
        <div className="ml-3 border-l border-border/40">
          {error && (
            <div className="px-3 py-1 text-[11px] text-destructive">{error}</div>
          )}
          {opening && !childId && (
            <div className="px-3 py-1 text-[11px] italic text-muted-foreground">
              …
            </div>
          )}
          {childId && (
            <SingleDbExplorer
              connectionId={childId}
              title={dbName}
              headerLevel="nested"
              controlledFilter={filter}
              onTableOpen={onTableOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (not exported — internal to this module)
// ---------------------------------------------------------------------------

interface TableActions {
  openTab: ReturnType<typeof useTabs.getState>["open"];
  refresh: () => void;
  onRename: (table: TableInfo) => void;
  onDrop: (table: TableInfo) => void;
  onEmpty: (table: TableInfo) => void;
  onRenameView: (view: TableInfo) => void;
  onDropView: (view: TableInfo) => void;
  driver: Driver | undefined;
}

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  items: TableInfo[];
  sectionKey: string;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  actions: TableActions;
  /** Force every section to render open (used by the filter). */
  forceOpen?: boolean;
}

/** Renders the right-aligned per-table metric badge (row count or size). */
function tableMetricLabel(t: TableInfo, metric: SchemaTableMetric): string | null {
  // `!= null` covers both `undefined` (field omitted) and `null` (older
  // payloads / drivers that serialized a null stat). `formatCount`/`formatBytes`
  // additionally guard non-finite input, so a stray null can never crash here.
  if (metric === "row-count" && t.row_count != null) {
    return formatCount(t.row_count);
  }
  if (metric === "size" && t.size_bytes != null) {
    return formatBytes(t.size_bytes);
  }
  return null;
}

/** Expandable section listing a set of tables or views within a schema. */
function TableSection({
  label,
  icon,
  items,
  sectionKey,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  actions,
  forceOpen,
}: SectionProps) {
  // Inner i18n hook — the table loop shadows `t`, so we use the function
  // directly via `i18n.t` here is overkill; instead alias it.
  const { t: translate } = useTranslation();
  const isOpen = forceOpen ? true : cs.expanded.has(sectionKey);
  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
        onClick={() => toggleNode(connectionId, sectionKey)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        )}
        {icon}
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto text-3xs tabular-nums text-muted-foreground/60">
          {items.length}
        </span>
      </button>

      {isOpen &&
        items.map((t) => (
          <TableRow
            key={tableKey(t.schema, t.name)}
            table={t}
            connectionId={connectionId}
            cs={cs}
            toggleNode={toggleNode}
            loadColumns={loadColumns}
            actions={actions}
            metric={metric}
            loadingLabel={translate("schema.loadingColumns")}
          />
        ))}
    </div>
  );
}

/** One table/view row + its expandable column list, wrapped in a context
 *  menu with the destructive (DROP) and renaming actions. */
function TableRow({
  table,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  actions,
  metric,
  loadingLabel,
}: {
  table: TableInfo;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  actions: TableActions;
  metric: SchemaTableMetric;
  loadingLabel: string;
}) {
  const { t: ct } = useTranslation();
  const t = table;
  const k = tableKey(t.schema, t.name);
  const tableNodeKey = `table:${k}`;
  const tableOpen = cs.expanded.has(tableNodeKey);
  const cols = cs.columns[k];
  const isView = t.kind === "view";

  // Reflect the currently-open table tab so the tree shows "you are here".
  // The selector returns a primitive string, so it's reference-stable and
  // safe as a Zustand selector (stores gotcha #1). NUL separators avoid any
  // schema/table name colliding with the delimiter.
  const activeTableKey = useTabs((s) => {
    const a = s.tabs.find((x) => x.id === s.activeId);
    return a && a.kind === "table"
      ? `${a.connectionId} ${a.schema ?? ""} ${a.table}`
      : null;
  });
  const isActive =
    activeTableKey === `${connectionId} ${t.schema ?? ""} ${t.name}`;

  // Whether this table is open in a tab *anywhere* (not just the active one),
  // so the tree can answer "do I have this open?" at a glance when many tabs
  // are open. Returns a primitive boolean → reference-stable selector return
  // (stores gotcha #1).
  const isOpen = useTabs((s) =>
    s.tabs.some(
      (x) =>
        x.kind === "table" &&
        x.connectionId === connectionId &&
        (x.schema ?? "") === (t.schema ?? "") &&
        x.table === t.name,
    ),
  );

  const copyName = () => {
    void navigator.clipboard.writeText(t.name);
  };
  const copySelect = () => {
    if (actions.driver === "mongodb") {
      // MongoDB has no SQL; produce a mongosh find() snippet instead.
      void navigator.clipboard.writeText(`db.${t.name}.find({}).limit(100)`);
      return;
    }
    const qualified = qualifyForCopy(actions.driver, t.schema, t.name);
    void navigator.clipboard.writeText(`SELECT * FROM ${qualified};`);
  };

  const isMongo = actions.driver === "mongodb";

  // MongoDB per-collection JSON export/import (#65). The save dialog is opened
  // backend-side (like the SQL "Export database"); import picks the file here,
  // confirms, then hands the path to the backend which parses + inserts.
  const exportCollectionJson = async () => {
    try {
      const path = await api.exportCollection(connectionId, t.name);
      toast.success(ct("schema.exportCollection.success", { path }));
    } catch (e) {
      const message = String(e);
      if (!message.includes("export cancelled")) toast.error(message);
    }
  };
  const importCollectionJson = async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: ct("schema.importCollection.pickTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    if (
      !confirmDestructive(
        ct("schema.importCollection.confirm", { collection: t.name }),
      )
    ) {
      return;
    }
    try {
      const count = await api.importCollection(connectionId, t.name, picked);
      toast.success(ct("schema.importCollection.success", { count }));
      actions.refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <div
            className={cn(
              "flex items-center pl-8 pr-2 hover:bg-accent/30",
              // Active-table "you are here" marker: soft brand wash + a 2px
              // inset brand rail (inset shadow, so it adds no layout shift).
              isActive &&
                "bg-brand/10 shadow-[inset_2px_0_0_hsl(var(--brand))] hover:bg-brand/15",
            )}
          >
            <button
              onClick={() => {
                toggleNode(connectionId, tableNodeKey);
                if (!cols) loadColumns(connectionId, t.schema, t.name);
              }}
              className="flex flex-1 items-center gap-1 py-0.5"
            >
              {tableOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {isView ? (
                <Eye
                  className={cn(
                    "h-3.5 w-3.5",
                    isActive ? "text-brand" : "text-muted-foreground",
                  )}
                />
              ) : (
                <TableIcon
                  className={cn(
                    "h-3.5 w-3.5",
                    isActive ? "text-brand" : "text-muted-foreground",
                  )}
                />
              )}
              <span
                className={cn(
                  // min-w-0 lets this flex-item shrink below its content's
                  // intrinsic width so `truncate` can actually clip long
                  // names — without it the row overflows and the metric
                  // badge gets pushed off, forcing horizontal scroll.
                  "min-w-0 truncate text-xs",
                  // Table name is the row's primary target → the boldest leaf
                  // in the 3-tier ramp (section label muted / column muted).
                  isActive
                    ? "font-semibold text-brand"
                    : "font-medium text-foreground",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openTab({
                    kind: "table",
                    title: tableTabTitle(
                      useConnections.getState().profiles,
                      connectionId,
                      t.name,
                    ),
                    connectionId,
                    schema: t.schema,
                    table: t.name,
                  });
                }}
              >
                {t.name}
              </span>
              {isOpen && !isActive && (
                // "Open in a tab" marker — a soft brand dot so you can tell,
                // while browsing, which tables you already have open (the
                // active one carries the stronger rail + bold instead).
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"
                  aria-label={ct("schema.tableOpenTooltip")}
                  title={ct("schema.tableOpenTooltip")}
                />
              )}
              {(() => {
                const badge = tableMetricLabel(t, metric);
                return badge ? (
                  <span className="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-muted-foreground">
                    {badge}
                  </span>
                ) : null;
              })()}
            </button>
          </div>

          {tableOpen && (
            // Column list. `ml-8` aligns the depth guide to the table row's
            // left edge (pl-8) so the vertical hairline drops straight down
            // from under the table's chevron — a continuous tree guide, and a
            // consistent 12px-per-level indent ladder (schema 8 → section 20 →
            // table 32). Brand-tinted while this table is the active tab.
            <div
              className={cn(
                "ml-8 border-l pl-3 pr-2",
                isActive ? "border-brand/40" : "border-border/60",
              )}
            >
              {cols ? (
                cols.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-1 py-0.5 text-2xs text-muted-foreground"
                  >
                    {c.is_primary_key && (
                      <KeyRound
                        className="h-2.5 w-2.5 shrink-0 text-pk"
                        aria-label="primary key"
                      />
                    )}
                    {c.referenced_table && (
                      <KeyRound
                        className="h-2.5 w-2.5 shrink-0 text-fk"
                        aria-label={`foreign key → ${c.referenced_table}`}
                      />
                    )}
                    <span className="truncate">{c.name}</span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 pl-2 text-3xs uppercase",
                        typeColorClass(c.data_type),
                      )}
                    >
                      {c.data_type}
                    </span>
                  </div>
                ))
              ) : (
                <ColumnSkeleton label={loadingLabel} />
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            actions.openTab({
              kind: "table",
              title: tableTabTitle(
                useConnections.getState().profiles,
                connectionId,
                t.name,
              ),
              connectionId,
              schema: t.schema,
              table: t.name,
            })
          }
        >
          {ct("schema.context.open")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyName}>
          {ct("schema.context.copyName")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={copySelect}>
          {ct("schema.context.copySelect")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.refresh()}>
          {ct("schema.context.refresh")}
        </ContextMenuItem>
        {/* MongoDB collections: JSON data import/export + drop. No SQL DDL
            (structure editing is read-only / rename is unsupported for Mongo). */}
        {isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void exportCollectionJson()}>
              {ct("schema.exportCollection.title")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void importCollectionJson()}>
              {ct("schema.importCollection.title")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => actions.onEmpty(t)}>
              {ct("schema.context.empty")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => actions.onDrop(t)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              {ct("schema.context.drop")}
            </ContextMenuItem>
          </>
        )}
        {/* Views fall through to read-only; we only expose DDL on base tables. */}
        {!isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                actions.openTab({
                  kind: "structure",
                  structureMode: "edit",
                  title: `${t.name} (${ct("tabs.structureSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            >
              {ct("schema.context.editStructure")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onRename(t)}>
              {ct("schema.context.rename")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onEmpty(t)}>
              {ct("schema.context.empty")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => actions.onDrop(t)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              {ct("schema.context.drop")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                actions.openTab({
                  kind: "structure",
                  structureMode: "new",
                  title: ct("schema.context.newTable"),
                  connectionId,
                  schema: t.schema,
                })
              }
            >
              {ct("schema.context.newTable")}
            </ContextMenuItem>
          </>
        )}
        {/* Views: no column/index/FK editing (a view has none of its own),
            but the definition itself is editable — see issue #86. MongoDB
            views are read-only aggregation pipelines, so excluded here too
            (same reasoning as the table-DDL guard above). */}
        {!isMongo && isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                actions.openTab({
                  kind: "view",
                  viewMode: "edit",
                  title: `${t.name} (${ct("tabs.viewSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  view: t.name,
                })
              }
            >
              {ct("schema.context.editView")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onRenameView(t)}>
              {ct("schema.context.renameView")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => actions.onDropView(t)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              {ct("schema.context.dropView")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                actions.openTab({
                  kind: "view",
                  viewMode: "new",
                  title: ct("schema.context.newView"),
                  connectionId,
                  schema: t.schema,
                })
              }
            >
              {ct("schema.context.newView")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Build the table reference used inside the "Copy SELECT" snippet. We
 *  quote with the driver's conventional identifier delimiters so the
 *  snippet pastes cleanly into the query editor — even for case-sensitive
 *  Postgres identifiers or MySQL reserved words. */
function qualifyForCopy(
  driver: Driver | undefined,
  schema: string,
  table: string,
): string {
  if (driver === "mysql") {
    return schema
      ? `\`${schema}\`.\`${table}\``
      : `\`${table}\``;
  }
  // postgres / sqlite / unknown — use double quotes.
  return schema ? `"${schema}"."${table}"` : `"${table}"`;
}

/** Modal for renaming a table. Validates against empty input and
 *  surfaces the backend error in-place. */
function RenameTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(target.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === target.name) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.renameTable(connectionId, target.schema, target.name, trimmed);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.rename.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.rename.description", { name: target.name })}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("schema.rename.newName")}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.rename.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={
              submitting ||
              !newName.trim() ||
              newName.trim() === target.name
            }
          >
            {submitting ? t("schema.rename.renaming") : t("schema.rename.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Same shape as {@link RenameTableDialog} but for a view — calls
 *  `renameView` instead of `renameTable`. Kept as a separate component
 *  rather than parametrizing the table one, since the latter is tightly
 *  coupled to the table API call. */
function RenameViewDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(target.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === target.name) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.renameView(connectionId, target.schema, target.name, trimmed);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.renameView.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.renameView.description", { name: target.name })}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("schema.rename.newName")}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.renameView.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={
              submitting ||
              !newName.trim() ||
              newName.trim() === target.name
            }
          >
            {submitting ? t("schema.rename.renaming") : t("schema.rename.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Same shape as {@link DropTableDialog} but for a view — calls `dropView`
 *  instead of `dropTable`. A view holds no data of its own, so unlike
 *  `EmptyTableDialog`'s preference-gated confirmation, this always confirms
 *  (dropping a view definition is not something to skip confirming). */
function DropViewDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.dropView(connectionId, target.schema, target.name);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.dropView.title", { name: target.name })}</DialogTitle>
          <DialogDescription>{t("schema.dropView.description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.dropView.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? t("schema.drop.dropping") : t("schema.drop.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Modal for `CREATE DATABASE` — the "+" button in both the multi-DB
 *  explorer toolbar and the single-DB root header. Postgres/MySQL only;
 *  see `create_database`'s doc comment for why. */
function CreateDatabaseDialog({
  connectionId,
  onClose,
  onDone,
}: {
  connectionId: string;
  onClose: () => void;
  /** Fired with the created database's name — a single-DB caller has no
   *  visible list to refresh, so it uses this to confirm success instead. */
  onDone: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createDatabase(connectionId, trimmed);
      onDone(trimmed);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.createDatabase.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.createDatabase.description")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("schema.createDatabase.namePlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.createDatabase.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting
              ? t("schema.createDatabase.creating")
              : t("schema.createDatabase.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Modal for creating a MongoDB collection (#61) — the collection analogue of
 *  `CreateDatabaseDialog`. Reached from the Mongo database context menu and the
 *  single-DB Mongo toolbar. `connectionId` must already be scoped to the target
 *  database (a `<parent>::db::<db>` view for a cluster), so the caller resolves
 *  it before opening this. */
function CreateCollectionDialog({
  connectionId,
  onClose,
  onDone,
}: {
  connectionId: string;
  onClose: () => void;
  /** Fired with the created collection's name so the caller can refresh the
   *  tree and/or toast success. */
  onDone: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createCollection(connectionId, trimmed);
      onDone(trimmed);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.createCollection.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.createCollection.description")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("schema.createCollection.namePlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.createCollection.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting
              ? t("schema.createCollection.creating")
              : t("schema.createCollection.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** DataGrip-style "choose which databases to show" picker (#64). Persists the
 *  subset on the profile (`visible_databases`); "all selected" stores `null`
 *  so newly-created databases keep appearing automatically. Save is disabled
 *  with nothing selected — an empty subset would hide the whole tree, which is
 *  never what the user wants. */
function DatabaseVisibilityDialog({
  profileId,
  databases,
  selected,
  onClose,
}: {
  profileId: string;
  /** Every database name currently known for the connection. */
  databases: string[];
  /** The persisted subset, or null when all are shown. */
  selected: string[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(selected ?? databases),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = sel.size === databases.length;

  const toggle = (name: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleAll = () =>
    setSel(allSelected ? new Set() : new Set(databases));

  const submit = async () => {
    if (sel.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const chosen = databases.filter((n) => sel.has(n));
      // "All" → null so future databases stay visible; a proper subset is
      // stored verbatim.
      const value = chosen.length === databases.length ? null : chosen;
      const profile = useConnections
        .getState()
        .profiles.find((p) => p.id === profileId);
      if (profile) {
        await useConnections.getState().save({
          ...profile,
          visible_databases: value,
        });
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.selectDatabases.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.selectDatabases.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between pb-1">
          <span className="text-xs text-muted-foreground">
            {t("schema.selectDatabases.count", {
              selected: sel.size,
              total: databases.length,
            })}
          </span>
          <button
            onClick={toggleAll}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {allSelected
              ? t("schema.selectDatabases.deselectAll")
              : t("schema.selectDatabases.selectAll")}
          </button>
        </div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {databases.map((name) => (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={sel.has(name)}
                onChange={() => toggle(name)}
                className="h-3.5 w-3.5 rounded accent-primary"
              />
              <span className="flex-1 truncate text-xs">{name}</span>
            </label>
          ))}
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting || sel.size === 0}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Modal for dropping a table. Requires the user to retype the table
 *  name verbatim before the destructive button enables — same pattern
 *  GitHub uses for repository deletion. */
function DropTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.dropTable(connectionId, target.schema, target.name);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.drop.title", { name: target.name })}</DialogTitle>
          <DialogDescription>{t("schema.drop.description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.drop.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? t("schema.drop.dropping") : t("schema.drop.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirmation for emptying a table (#69). Unlike the always-on DROP dialog,
 *  this carries a "don't ask again" checkbox that flips the dedicated
 *  `ui.confirmEmptyTable` preference off, so a power user who empties log
 *  tables often can silence just this prompt. */
function EmptyTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const updateUi = usePreferences((s) => s.updateUi);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dontAsk, setDontAsk] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.emptyTable(connectionId, target.schema, target.name);
      if (dontAsk) updateUi({ confirmEmptyTable: false });
      toast.success(t("schema.empty.emptied", { name: target.name }));
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.empty.title", { name: target.name })}</DialogTitle>
          <DialogDescription>{t("schema.empty.description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.empty.failed", { message: error })}
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-brand"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          {t("schema.empty.dontAskAgain")}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? t("schema.empty.emptying") : t("schema.empty.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Collapsible "indexes" section header within a schema node. */
function IndexesSectionHeader({
  label,
  sectionKey,
  connectionId,
  expanded,
  toggleNode,
}: {
  label: string;
  sectionKey: string;
  connectionId: string;
  expanded: Set<string>;
  toggleNode: (connectionId: string, key: string) => void;
}) {
  const isOpen = expanded.has(sectionKey);
  return (
    <button
      className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
      onClick={() => toggleNode(connectionId, sectionKey)}
    >
      {isOpen ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
      )}
      <LayoutList className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </button>
  );
}
