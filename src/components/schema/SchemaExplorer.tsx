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

import { cloneElement, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  DatabaseZap,
  Download,
  Eraser,
  ExternalLink,
  Table as TableIcon,
  Eye,
  FolderPlus,
  KeyRound,
  LayoutList,
  ListFilter,
  PencilLine,
  Plug,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
  Table2,
  Trash2,
  Unplug,
  Upload,
  Workflow,
} from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useSchema, tableKey } from "@/stores/session/schema";
import { useTabs, retitleTabsForTableRename } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";
import { tableTabTitle } from "@/lib/connectionLabel";
import { usePreferences } from "@/stores/preferences/preferences";
import { api } from "@/lib/tauri";
import {
  openTrackedDatabaseView,
  persistLaunchState,
} from "@/stores/session/persistedTabs";
import { toast } from "sonner";
import { splitSql } from "@/lib/sql/sqlSplit";
import type { SchemaTableMetric } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
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
import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { confirmDestructive } from "@/lib/confirmDestructive";
import {
  ExportDatabaseDialog,
  type ExportScope,
} from "@/components/schema/dialogs/ExportDatabaseDialog";
import {
  ImportSqlDialog,
  type ImportScope,
} from "@/components/schema/dialogs/ImportSqlDialog";
import { resolveVisibleDatabases } from "@/lib/connection/visibleDatabases";
import { isTooManyConnections } from "@/lib/db/driver";
import type { Driver, TableInfo } from "@/types";
import {
  supportsCreateDatabase,
  supportsDdlEditing,
  supportsSqlDump,
} from "@/lib/db/driver";

/**
 * How many databases the cross-database search may open at once.
 *
 * Every `openDatabaseView` is a separate connection pool against the same
 * server, so an unbounded fan-out here is indistinguishable from a
 * denial-of-service against a database the user shares with their IDE, their
 * application backend and any MCP sidecars. Three keeps the search feeling
 * responsive on a server with a handful of databases while making the
 * nineteen-database case a queue rather than a burst.
 */
const PREFETCH_CONCURRENCY = 3;

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

/**
 * Pick a `.sql` file and split it into statement texts — the frontend half
 * of the import flow. Execution (and the target-database choice for
 * multi-DB connections) happens in `ImportSqlDialog`, which the caller opens
 * with the returned list. `null` when the user cancels the picker or the
 * file holds no statements.
 */
async function pickAndSplitSqlFile(t: Translate): Promise<string[] | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: t("schema.importSql.pickTitle"),
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  if (typeof picked !== "string" || !picked) return null;
  const text = await api.readTextFile(picked);
  const statements = splitSql(text).map((s) => s.text);
  return statements.length > 0 ? statements : null;
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

/**
 * Resolve the "databases to show" subset for a connection, in the two layers it
 * is stored in: the active environment's override wins, and the profile's
 * `visible_databases` is the fallback. `null` from either layer means "show
 * all"; the difference is that the environment can *hold* a `null` to widen a
 * subset the profile narrows (see `useUi.databaseVisibility`).
 *
 * A hook rather than a plain function because both layers are stores and the
 * result has to re-render on either changing. Both selectors return an existing
 * reference (or `null`/`undefined`), never a fresh array, so gotcha #1 holds.
 */
export function useVisibleDatabases(connectionId: string): string[] | null {
  const override = useUi((s) => s.databaseVisibility[connectionId]);
  const fromProfile = useConnections(
    (s) => s.profiles.find((p) => p.id === connectionId)?.visible_databases ?? null,
  );
  // The resolution itself lives in `lib/connection/visibleDatabases.ts` so the
  // command palette, which needs the answer for many connections at once, can
  // share it instead of re-deriving the override/profile precedence.
  return resolveVisibleDatabases(override, fromProfile);
}

export function SchemaExplorer({
  connectionId,
  filter = "",
}: {
  connectionId: string;
  /**
   * Needle from the tree-level filter box (`ConnectionsTree.tsx`). The
   * caller decides scope — it passes the live filter only for the selected
   * connection and `""` for every other one, so this component never has to
   * know whether it's the active target.
   */
  filter?: string;
}) {
  // Multi-DB mode triggers when the parent profile has no `database` set
  // (e.g. the user wants to browse every database on the server). SQLite
  // profiles are inherently single-file, so they never enter this mode.
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isMultiDb =
    !!profile && profile.driver !== "sqlite" && profile.database === "";

  // The origin notice sits above whichever explorer renders (#108). Placed on
  // this wrapper rather than inside the two explorers so single- and multi-DB
  // mode can't drift, and above the tree because it's about the connection
  // itself, not about anything in its schema.
  return (
    <div className="flex flex-col">
      <VanishedOriginNotice profileId={connectionId} />
      {isMultiDb ? (
        <MultiDbExplorer parentId={connectionId} filter={filter} />
      ) : (
        <SingleDbExplorer connectionId={connectionId} filter={filter} />
      )}
    </div>
  );
}

/**
 * Right-click menu for a connection, wrapping whatever row represents it.
 *
 * These actions used to be an icon strip in the explorer's header. Once the
 * explorer became a subtree of the connections tree (#107) that strip repeated
 * under every expanded connection — five icons and a filter box each — so it
 * moved here, where a connection's actions belong: on the connection.
 *
 * Lives in this file rather than next to the tree because everything it drives is
 * already here: the three dialogs and the export/import/security helpers. Moving
 * the menu out would mean exporting six internals to keep one component tidy.
 *
 * What's offered is driver- and mode-aware, and the distinctions are the same
 * ones the two explorers already encoded: `CREATE DATABASE` is Postgres/MySQL
 * only, create-collection is MongoDB's stand-in for it, whole-database `.sql`
 * export/import needs exactly one target database (so never in multi-DB mode),
 * and the visible-databases subset only means anything when there are several.
 *
 * Connect/disconnect are delegated: the tree owns what those do to focus and to
 * its expansion overrides, and duplicating that here would let the two drift.
 */
export function ConnectionActionsMenu({
  connectionId,
  onConnect,
  onDisconnect,
  children,
}: {
  connectionId: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** A single element (Radix `asChild` requirement) — cloned below to carry
   *  the "menu is open on me" ring while right-clicked. */
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isActive = useConnections((s) => s.active.has(connectionId));
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importStatements, setImportStatements] = useState<string[] | null>(
    null,
  );
  // Right-clicking to open the menu doesn't keep the row hovered (the
  // pointer moves onto the menu itself), so without this the row you
  // targeted looks indistinguishable from any other once the menu is open.
  // Mirrors the row's own `focus-visible:ring-ring` treatment, just driven
  // by the menu's open state instead of keyboard focus.
  const [menuOpen, setMenuOpen] = useState(false);

  const driver = profile?.driver;
  const isMultiDb = !!profile && driver !== "sqlite" && profile.database === "";
  const canCreateDatabase = supportsCreateDatabase(driver);
  const canCreateCollection = driver === "mongodb" && !isMultiDb;
  // Whole-database `.sql` export/import used to require single-DB mode
  // (nothing to pick a database *from* otherwise); the export/import
  // dialogs now handle multi-DB themselves — a database picker for export,
  // a target-database dropdown for import — so this is SQL-only, not also
  // single-DB-only.
  const canDumpSql = supportsSqlDump(driver);
  const databases = cs?.databases ?? [];
  const exportScope: ExportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId, databaseName: profile?.database || connectionId };
  const importScope: ImportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId };

  return (
    <>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          {cloneElement(children, {
            className: cn(
              children.props.className,
              menuOpen && "ring-1 ring-inset ring-ring",
            ),
          })}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isActive ? (
            <>
              <ContextMenuAction
                icon={RefreshCw}
                label={t("schema.refresh")}
                onSelect={() => refresh(connectionId)}
              />
              {canCreateDatabase && (
                <ContextMenuAction
                  icon={DatabaseZap}
                  label={t("schema.createDatabase.title")}
                  onSelect={() => setCreateDbOpen(true)}
                />
              )}
              {canCreateCollection && (
                <ContextMenuAction
                  icon={FolderPlus}
                  label={t("schema.createCollection.title")}
                  onSelect={() => setCreateCollectionOpen(true)}
                />
              )}
              {isMultiDb && (
                <ContextMenuAction
                  icon={ListFilter}
                  // Nothing to choose from until the database list has loaded.
                  disabled={databases.length === 0}
                  label={t("schema.selectDatabases.title")}
                  onSelect={() => setDbPickerOpen(true)}
                />
              )}
              {canDumpSql && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuAction
                    icon={Download}
                    label={t("schema.exportDatabase.title")}
                    onSelect={() => setExportOpen(true)}
                  />
                  <ContextMenuAction
                    icon={Upload}
                    label={t("schema.importSql.title")}
                    onSelect={() =>
                      void pickAndSplitSqlFile(t).then((statements) => {
                        if (statements) setImportStatements(statements);
                      })
                    }
                  />
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={ShieldCheck}
                label={t("security.title")}
                onSelect={() => openSecurityTab(connectionId, t("security.title"))}
              />
              {onDisconnect && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuAction
                    icon={Unplug}
                    label={t("statusBar.disconnect")}
                    onSelect={onDisconnect}
                  />
                </>
              )}
            </>
          ) : (
            onConnect && (
              <ContextMenuAction
                icon={Plug}
                label={t("connectionsTree.connect")}
                onSelect={onConnect}
              />
            )
          )}
        </ContextMenuContent>
      </ContextMenu>

      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={connectionId}
          onClose={() => setCreateDbOpen(false)}
          onDone={(name) => {
            setCreateDbOpen(false);
            refresh(connectionId);
            // Always toast, unlike the old multi-DB toolbar button, which relied
            // on the new node appearing in the tree as its own confirmation.
            // Driven from a connection row, the subtree may well be collapsed.
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
      {dbPickerOpen && (
        <DatabaseVisibilityDialog
          profileId={connectionId}
          databases={databases.map((db) => db.name)}
          onClose={() => setDbPickerOpen(false)}
        />
      )}
      {exportOpen && (
        <ExportDatabaseDialog scope={exportScope} onClose={() => setExportOpen(false)} />
      )}
      {importStatements && (
        <ImportSqlDialog
          scope={importScope}
          statements={importStatements}
          onClose={() => setImportStatements(null)}
          onImported={(id) => {
            setImportStatements(null);
            refresh(id);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Single-database explorer (used directly for profiles with `database` set,
// and as the inner subtree of each database node in multi-DB mode).
// ---------------------------------------------------------------------------

function SingleDbExplorer({
  connectionId,
  headerLevel = "root",
  filter = "",
  onTableOpen,
}: {
  connectionId: string;
  /**
   * `nested` skips the schema header when there's exactly one schema to
   * show (see `flattenSingleSchema` below) — used when this subtree lives
   * under a database node and the outer multi-DB explorer already owns
   * the database-level chrome.
   */
  headerLevel?: "root" | "nested";
  /**
   * Filter needle. Always owned by an ancestor: the tree-level filter box
   * in `ConnectionsTree.tsx` for a root explorer (via `SchemaExplorer`), or
   * `MultiDbExplorer` for a nested one — propagated so every nested DB
   * filters by the same needle, which was the whole point of the multi-DB
   * unification.
   */
  filter?: string;
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

  // Which schema header (if any) currently has its right-click menu open —
  // there's one `ContextMenu` per schema rendered by the `schemas.map(...)`
  // below, so this can't be a `useState` inside that loop (Rules of Hooks);
  // tracking "which name" in the enclosing component instead works the same
  // way since only one context menu can realistically be open at a time.
  const [openSchemaMenu, setOpenSchemaMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<TableInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<TableInfo | null>(null);
  const [emptyTarget, setEmptyTarget] = useState<TableInfo | null>(null);
  const [renameViewTarget, setRenameViewTarget] = useState<TableInfo | null>(
    null,
  );
  const [dropViewTarget, setDropViewTarget] = useState<TableInfo | null>(null);
  // Create-database / create-collection / export / import / security used to be
  // an icon strip in this explorer's header. They are connection-level actions,
  // so they now live on the connection row's right-click menu
  // ([[ConnectionActionsMenu]]) — which is also where their driver conditions
  // and their dialogs moved.

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
    <div className="flex flex-col">
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="pb-1 text-sm">
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
                    duplicate database node (see comment above). Its
                    right-click menu is where table/view creation belongs
                    ([[schema.context.newTable]] used to live on an existing
                    table's own menu, which meant a database with zero
                    tables had no way to grow one from the tree). */}
                {!flattenSingleSchema && (
                  <ContextMenu
                    onOpenChange={(open) =>
                      setOpenSchemaMenu(open ? schema : null)
                    }
                  >
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          "flex w-full items-center gap-1 px-2 py-1.5 hover:bg-accent/40",
                          openSchemaMenu === schema &&
                            "ring-1 ring-inset ring-ring",
                        )}
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
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuAction
                        icon={RefreshCw}
                        label={t("schema.refresh")}
                        onSelect={() => refresh(connectionId)}
                      />
                      <ContextMenuSeparator />
                      <ContextMenuAction
                        icon={Table2}
                        label={t("schema.context.newTable")}
                        onSelect={() =>
                          wrappedOpenTab({
                            kind: "structure",
                            structureMode: "new",
                            title: t("schema.context.newTable"),
                            connectionId,
                            schema,
                          })
                        }
                      />
                      {supportsDdlEditing(driver) && (
                        <ContextMenuAction
                          icon={Eye}
                          label={t("schema.context.newView")}
                          onSelect={() =>
                            wrappedOpenTab({
                              kind: "view",
                              viewMode: "new",
                              title: t("schema.context.newView"),
                              connectionId,
                              schema,
                            })
                          }
                        />
                      )}
                      <ContextMenuAction
                        icon={SquareTerminal}
                        label={t("schema.context.newQueryHere")}
                        onSelect={() =>
                          openTab({
                            kind: "query",
                            title: t("tabs.queryFileName"),
                            connectionId,
                            query: "-- write a SQL query and press Ctrl+Enter\n",
                          })
                        }
                      />
                    </ContextMenuContent>
                  </ContextMenu>
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

function MultiDbExplorer({
  parentId,
  filter = "",
}: {
  parentId: string;
  /** Needle from the tree-level filter box, forwarded by `SchemaExplorer`. */
  filter?: string;
}) {
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
  const canCreateDatabase = supportsCreateDatabase(driver);
  // DataGrip-style visible-databases subset. `null`/empty = show all. Resolved
  // across both layers (this environment's override, then the profile) rather
  // than read off the profile: the profile is global, so reading it directly is
  // what used to leak one environment's subset into all the others.
  const visibleDatabases = useVisibleDatabases(parentId);
  // Whether the subset in force is this environment's override rather than the
  // profile's default — worth saying out loud in the header, since the same
  // connection can legitimately show a different set in the next environment.
  const subsetIsLocal = useUi(
    (s) => s.databaseVisibility[parentId] !== undefined,
  );
  const visibleSet = useMemo(
    () =>
      visibleDatabases && visibleDatabases.length > 0
        ? new Set(visibleDatabases)
        : null,
    [visibleDatabases],
  );
  // Subscribe to the whole map so `matchingDbs` reactively recomputes
  // as each prefetch lands. The membership check is cheap (Map lookup
  // per database) so the broader subscription is fine here.
  const byConnection = useSchema((s) => s.byConnection);

  // The database the user is currently focused on (last expanded or last
  // table clicked). When set, the filter scopes to this DB only — same
  // model as HeidiSQL. null → search across all DBs (retrocompat).
  const [activeDatabaseName, setActiveDatabaseName] = useState<string | null>(null);

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
  //
  // **Bounded since 1.13.0.** This loop used to start every database at once.
  // Each `openDatabaseView` opens a whole separate connection pool, so on a
  // server with nineteen databases one keystroke fired nineteen simultaneous
  // connection attempts — a burst large enough on its own to exhaust a shared
  // server's connection limit, and the single most likely trigger behind the
  // "too many connections" reports. It now runs at most
  // `PREFETCH_CONCURRENCY` at a time; `pumpTick` re-runs this effect as each
  // one settles so the queue keeps draining. (The effect's `byConnection`
  // dependency covers the success path on its own, but not a failure, which
  // touches no store — hence an explicit tick rather than relying on it.)
  const inFlightPrefetch = useRef<Set<string>>(new Set());
  const [pumpTick, setPumpTick] = useState(0);
  // Circuit breaker: once the server says it is full, stop. Without this the
  // fan-out re-fires on the next keystroke against a server already refusing
  // it, which turns one failure into a stream of them and delays recovery.
  const [limitReached, setLimitReached] = useState(false);
  useEffect(() => {
    setLimitReached(false);
  }, [parentId]);
  useEffect(() => {
    if (debouncedNeedle.length < 2 || !cs || limitReached) return;
    // When a database is active, only prefetch that one — avoids a full
    // fan-out across every database on large servers during scoped searches.
    const dbsToWarm = (
      activeDatabaseName
        ? cs.databases.filter((db) => db.name === activeDatabaseName)
        : cs.databases
    ).filter((db) => !visibleSet || visibleSet.has(db.name));
    for (const db of dbsToWarm) {
      if (inFlightPrefetch.current.size >= PREFETCH_CONCURRENCY) break;
      const childId = `${parentId}::db::${db.name}`;
      const childCs = byConnection[childId];
      if (childCs?.initialized || childCs?.loading) continue;
      if (inFlightPrefetch.current.has(childId)) continue;
      inFlightPrefetch.current.add(childId);
      api
        .openDatabaseView(parentId, db.name)
        .then((resolvedId) => refresh(resolvedId))
        .catch((e) => {
          // Silent, except for the one failure the user can act on: a
          // connection-limit refusal means every remaining database in the
          // queue would fail the same way.
          if (isTooManyConnections(e)) {
            setLimitReached(true);
            toast.error(String(e), {
              action: {
                label: t("schema.releaseIdlePools"),
                onClick: () => {
                  void api
                    .releaseIdlePools()
                    .then((closed) => {
                      toast.success(
                        t("schema.releasedIdlePools", { count: closed }),
                      );
                      setLimitReached(false);
                    })
                    .catch((err) => toast.error(String(err)));
                },
              },
            });
          }
        })
        .finally(() => {
          inFlightPrefetch.current.delete(childId);
          setPumpTick((n) => n + 1);
        });
    }
  }, [
    debouncedNeedle,
    cs,
    byConnection,
    pumpTick,
    limitReached,
    t,
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
    <div className="flex flex-col">
      {(visibleSet || (activeDatabaseName && filterActive)) && (
        <div className="px-3 pb-2">
          {activeDatabaseName && filterActive && (
            <div className="text-[11px] text-muted-foreground">
              {t("schema.filterScopedTo", { db: activeDatabaseName })}
            </div>
          )}
          {/* The header's brand-tinted "select databases" icon used to be the only
              sign that a subset was hiding databases. With the actions moved to the
              connection's context menu that cue would have vanished silently, so it
              is stated here instead. */}
          {visibleSet && (
            <div className="text-[11px] text-muted-foreground">
              {t(
                subsetIsLocal
                  ? "schema.selectDatabases.subsetActiveLocal"
                  : "schema.selectDatabases.subsetActive",
                {
                  count: visibleSet.size,
                  total: cs.databases.length,
                },
              )}
            </div>
          )}
        </div>
      )}
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="pb-1 text-sm">
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
  // See `ConnectionActionsMenu`'s matching state: the row that was
  // right-clicked stops looking hovered as soon as the pointer moves onto
  // the open menu, so this drives the same ring explicitly instead.
  const [menuOpen, setMenuOpen] = useState(false);
  /** The `<parent>::db::<db>` view id the create-collection dialog targets;
   *  non-null while the dialog is open (#61). */
  const [createCollectionId, setCreateCollectionId] = useState<string | null>(
    null,
  );

  // Resolve this database's synthetic `<parentId>::db::<db>` child id,
  // opening the pool the first time any action here needs it — every
  // per-database action below goes through this rather than calling
  // `api.openDatabaseView` directly. `openTrackedDatabaseView` (not the bare
  // `api` wrapper) is what hydrates the child's persisted tabs/schema
  // expansion and attaches its save subscription on that first open; a table,
  // query or security tab opened against a child id that skipped this never
  // gets remembered — not on the next reconnect, not across an environment
  // switch, not even across a plain app restart (see the CHANGELOG entry).
  // Returns `null` (after setting `error`) if the open fails, so callers can
  // just bail with `if (!id) return;`.
  const resolveChildId = async (): Promise<string | null> => {
    if (childId) return childId;
    try {
      const id = await openTrackedDatabaseView(parentId, dbName);
      setChildId(id);
      return id;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  // "New query here": open a query tab scoped to *this* database.
  const openQueryHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    useTabs.getState().open({
      kind: "query",
      title: t("tabs.queryFileName"),
      connectionId: id,
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  };

  // "New table"/"New view" here: same lazy-open-then-navigate pattern as
  // `openQueryHere`. These used to only be reachable from an existing
  // table's own context menu (see the schema-header menu's doc comment in
  // `SingleDbExplorer`), which meant a freshly-created, still-empty
  // database had no way to grow its first table from the tree at all.
  const createTableHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    useTabs.getState().open({
      kind: "structure",
      structureMode: "new",
      title: t("schema.context.newTable"),
      connectionId: id,
    });
  };
  const createViewHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    useTabs.getState().open({
      kind: "view",
      viewMode: "new",
      title: t("schema.context.newView"),
      connectionId: id,
    });
  };

  // "Security": same lazy-open-then-navigate pattern as `openQueryHere`,
  // scoped to this database's synthetic connection id.
  const openSecurityHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    openSecurityTab(id, t("security.title"));
  };

  // Export / import: same lazy-open-then-use pattern as `openQueryHere`,
  // scoped to this database's synthetic connection id. Both dialogs need
  // that id up front (scope `"single"`, locked to this one database), so
  // resolve it before opening either.
  const [exportTargetId, setExportTargetId] = useState<string | null>(null);
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const [importStatements, setImportStatements] = useState<string[] | null>(
    null,
  );

  const exportThisDatabase = async () => {
    const id = await resolveChildId();
    if (!id) return;
    setExportTargetId(id);
  };

  const importSqlHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    const statements = await pickAndSplitSqlFile(t);
    if (!statements) return;
    setImportTargetId(id);
    setImportStatements(statements);
  };

  // "New collection" (MongoDB): lazily resolve this database's synthetic view
  // id (same pattern as the handlers above) and open the create dialog scoped
  // to it. `create_collection` needs a pool bound to this specific database.
  const createCollectionHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
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
      const droppedId = `${parentId}::db::${dbName}`;
      useTabs.getState().closeForConnection(droppedId);
      useSchema.getState().drop(droppedId);
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
    resolveChildId().finally(() => setOpening(false));
  }, [effectiveExpanded, childId, opening, parentId, dbName]);

  return (
    <div>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              "flex w-full items-center gap-1 px-2 py-1.5 transition-opacity hover:bg-accent/40",
              dimmed && "opacity-50 hover:opacity-100",
              menuOpen && "ring-1 ring-inset ring-ring",
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
          <ContextMenuAction
            icon={RefreshCw}
            label={t("schema.refresh")}
            onSelect={() => void useSchema.getState().refresh(parentId)}
          />
          <ContextMenuSeparator />
          <ContextMenuAction
            icon={Table2}
            label={t("schema.context.newTable")}
            onSelect={() => void createTableHere()}
          />
          {supportsDdlEditing(driver) && (
            <ContextMenuAction
              icon={Eye}
              label={t("schema.context.newView")}
              onSelect={() => void createViewHere()}
            />
          )}
          <ContextMenuAction
            icon={SquareTerminal}
            label={t("schema.context.newQueryHere")}
            onSelect={() => void openQueryHere()}
          />
          {driver === "mongodb" && (
            <ContextMenuAction
              icon={FolderPlus}
              label={t("schema.createCollection.title")}
              onSelect={() => void createCollectionHere()}
            />
          )}
          {/* Whole-database .sql export/import needs a per-driver literal
              encoder: MongoDB databases use the per-collection JSON
              export/import instead (#65), and SQL Server has none yet. */}
          {supportsSqlDump(driver) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={Download}
                label={t("schema.exportDatabase.title")}
                onSelect={() => void exportThisDatabase()}
              />
              <ContextMenuAction
                icon={Upload}
                label={t("schema.importSql.title")}
                onSelect={() => void importSqlHere()}
              />
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuAction
            icon={ShieldCheck}
            label={t("security.title")}
            onSelect={() => void openSecurityHere()}
          />
          {canDrop && (
            <>
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={Trash2}
                destructive
                label={t("schema.context.dropDatabase")}
                onSelect={() => void dropThisDatabase()}
              />
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
      {exportTargetId && (
        <ExportDatabaseDialog
          scope={{ kind: "single", connectionId: exportTargetId, databaseName: dbName }}
          onClose={() => setExportTargetId(null)}
        />
      )}
      {importTargetId && importStatements && (
        <ImportSqlDialog
          scope={{ kind: "single", connectionId: importTargetId }}
          statements={importStatements}
          onClose={() => {
            setImportTargetId(null);
            setImportStatements(null);
          }}
          onImported={(id) => {
            setImportTargetId(null);
            setImportStatements(null);
            void useSchema.getState().refresh(id);
          }}
        />
      )}
      {effectiveExpanded && (
        <div className="ml-3 border-l border-border/35 pl-0.5">
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
              headerLevel="nested"
              filter={filter}
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
        className="flex w-full items-center gap-1 py-1 pl-5 pr-2 hover:bg-accent/30"
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
  const colError = cs.columnErrors?.[k];
  const isView = t.kind === "view";
  // See `ConnectionActionsMenu`'s matching state/comment: keeps the row
  // looking targeted once the pointer has moved off it onto the open menu.
  const [menuOpen, setMenuOpen] = useState(false);

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
  /** Rename and the view editor need a DDL builder for the driver; SQL Server
   *  doesn't have one yet, so it gets the same read-only treatment MongoDB has
   *  — except that its structure *view* is real (see below). */
  const canEditDdl = supportsDdlEditing(actions.driver);

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div>
          <div
            className={cn(
              "flex items-center pl-8 pr-2 hover:bg-accent/30",
              // Active-table "you are here" marker: soft brand wash + a 2px
              // inset brand rail (inset shadow, so it adds no layout shift).
              isActive &&
                "bg-brand/10 shadow-[inset_2px_0_0_hsl(var(--brand))] hover:bg-brand/15",
              // Right-clicked-and-menu-open marker — see the `menuOpen`
              // state's comment above.
              menuOpen && "ring-1 ring-inset ring-ring",
            )}
          >
            <button
              onClick={() => {
                toggleNode(connectionId, tableNodeKey);
                // Don't auto-relaunch a failed load on every toggle — the
                // retry button below is the explicit way to try again while
                // the error is still showing.
                if (!cols && !colError) loadColumns(connectionId, t.schema, t.name);
              }}
              className="flex flex-1 items-center gap-1 py-1"
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
                isActive ? "border-brand/40" : "border-border/35",
              )}
            >
              {cols ? (
                cols.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-1 py-1 text-2xs text-muted-foreground"
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
              ) : colError ? (
                <button
                  type="button"
                  onClick={() => loadColumns(connectionId, t.schema, t.name)}
                  className="flex items-center gap-1 py-1 text-2xs text-destructive/80 hover:text-destructive"
                  title={colError}
                >
                  <RefreshCw className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{ct("schema.columnsLoadError")}</span>
                </button>
              ) : (
                <ColumnSkeleton label={loadingLabel} />
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuAction
          icon={ExternalLink}
          label={ct("schema.context.open")}
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
        />
        <ContextMenuAction
          icon={Copy}
          label={ct("schema.context.copyName")}
          onSelect={copyName}
        />
        <ContextMenuAction
          icon={Code2}
          label={ct("schema.context.copySelect")}
          onSelect={copySelect}
        />
        <ContextMenuAction
          icon={RefreshCw}
          label={ct("schema.context.refresh")}
          onSelect={() => actions.refresh()}
        />
        {/* MongoDB collections: empty + drop. JSON data import/export used to
            live here too (#65) but has moved to the DataGrid toolbar's "Add
            data"/"Export data" controls (see `TableDataTab.tsx`), which act on
            the collection you're actually viewing instead of requiring a
            tree round-trip. No SQL DDL (structure editing is read-only /
            rename is unsupported for Mongo). */}
        {isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            {/* A pipeline over this collection — the entry point to the
                aggregation editor, and the way a new MongoDB view gets made
                (build the pipeline, then "Save as view"). */}
            <ContextMenuAction
              icon={Workflow}
              label={ct("schema.context.newAggregation")}
              onSelect={() =>
                actions.openTab({
                  kind: "aggregation",
                  viewMode: "new",
                  title: `${t.name} (${ct("tabs.aggregationSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            />
            {/* Indexes are the one piece of a Mongo collection's structure
                that is real rather than inferred, and the only part of it
                that can be edited — hence an entry of its own rather than a
                section inside the read-only structure tab. */}
            <ContextMenuAction
              icon={KeyRound}
              label={ct("schema.context.manageIndexes")}
              onSelect={() =>
                actions.openTab({
                  kind: "indexes",
                  title: `${t.name} (${ct("tabs.indexesSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            />
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Eraser}
              label={ct("schema.context.empty")}
              onSelect={() => actions.onEmpty(t)}
            />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.drop")}
              onSelect={() => actions.onDrop(t)}
            />
          </>
        )}
        {/* MongoDB views. Not covered by the `canEditDdl` block below: a Mongo
            view has no `CREATE VIEW` body to edit, it has a *pipeline* — so
            "Edit view" opens the aggregation editor with that pipeline loaded,
            and saving runs `collMod` rather than DDL. Renaming is absent
            because MongoDB has no rename for a view (drop and recreate is the
            only path, which is a different, destructive gesture). */}
        {isMongo && isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Workflow}
              label={ct("schema.context.editViewPipeline")}
              onSelect={() =>
                actions.openTab({
                  kind: "aggregation",
                  viewMode: "edit",
                  title: `${t.name} (${ct("tabs.aggregationSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  // No `table`: a view's source is its own `viewOn`, which the
                  // editor reads from the definition rather than assuming.
                  view: t.name,
                })
              }
            />
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.dropView")}
              onSelect={() => actions.onDropView(t)}
            />
          </>
        )}
        {/* Views fall through to read-only; we only expose DDL on base tables.
            Table/view *creation* lives one level up, on the database/schema
            node's own menu — see its doc comment — never here: this menu is
            for an existing table, and the old "New table…" entry buried at
            its tail was exactly the bug report that prompted this file's
            menu rework. */}
        {!isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            {/* Opens read-only on a driver without a DDL builder (SQL Server):
                the catalog introspection is complete, only `apply` is missing,
                and columns/PK/FK/index detail is worth showing regardless. */}
            <ContextMenuAction
              icon={SquarePen}
              label={ct("schema.context.editStructure")}
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
            />
            {canEditDdl && (
              <ContextMenuAction
                icon={PencilLine}
                label={ct("schema.context.rename")}
                onSelect={() => actions.onRename(t)}
              />
            )}
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Eraser}
              label={ct("schema.context.empty")}
              onSelect={() => actions.onEmpty(t)}
            />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.drop")}
              onSelect={() => actions.onDrop(t)}
            />
          </>
        )}
        {/* Views: no column/index/FK editing (a view has none of its own),
            but the definition itself is editable — see issue #86. MongoDB
            views are read-only aggregation pipelines, so excluded here too
            (same reasoning as the table-DDL guard above). */}
        {canEditDdl && isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={SquarePen}
              label={ct("schema.context.editView")}
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
            />
            <ContextMenuAction
              icon={PencilLine}
              label={ct("schema.context.renameView")}
              onSelect={() => actions.onRenameView(t)}
            />
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.dropView")}
              onSelect={() => actions.onDropView(t)}
            />
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
  // SQL Server accepts double quotes only under QUOTED_IDENTIFIER ON;
  // brackets always work, and are what a T-SQL user expects to see.
  if (driver === "sqlserver") {
    return schema ? `[${schema}].[${table}]` : `[${table}]`;
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
      retitleTabsForTableRename(
        useConnections.getState().profiles,
        connectionId,
        target.schema,
        target.name,
        trimmed,
        t("tabs.structureSuffix"),
      );
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

/** DataGrip-style "choose which databases to show" picker (#64). "All selected"
 *  stores `null` so newly-created databases keep appearing automatically, and
 *  save is disabled with nothing selected — an empty subset would hide the whole
 *  tree, which is never what the user wants.
 *
 *  Where the subset lands is the user's choice, because the two scopes answer
 *  different questions. **This environment** (the default) writes an override
 *  onto `LaunchState.databaseVisibility`, so the same test server can show every
 *  replica in one environment and a single client's database in another — the
 *  thing that was impossible while the subset lived only on the (global)
 *  profile. **All environments** writes `visible_databases` on the profile,
 *  which is also what travels through export/import and shared origins, and
 *  clears any local override so the choice is visibly in effect here too.
 *
 *  A profile published by a shared origin (`origin_id`) is read-only, so only
 *  the environment scope is offered for it: a profile-scoped save would be
 *  silently undone by the next sync. */
function DatabaseVisibilityDialog({
  profileId,
  databases,
  onClose,
}: {
  profileId: string;
  /** Every database name currently known for the connection. */
  databases: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === profileId),
  );
  const override = useUi((s) => s.databaseVisibility[profileId]);
  const hasOverride = override !== undefined;
  const fromProfile = profile?.visible_databases ?? null;
  const selected = hasOverride ? override : fromProfile;
  const fromOrigin = !!profile?.origin_id;
  const [scope, setScope] = useState<"environment" | "profile">(() => {
    // Editing happens where the value the user is looking at actually lives, so
    // tweaking an existing filter doesn't silently fork it into two layers. The
    // exception is a value that doesn't exist yet: a brand-new subset defaults
    // to this environment — the narrower, reversible choice, and the one people
    // expect (assuming otherwise is what made the original bug a surprise).
    if (hasOverride || fromOrigin) return "environment";
    return fromProfile ? "profile" : "environment";
  });
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

  /** Write the launch state so the override survives a restart / switch. */
  const persist = () =>
    persistLaunchState(Array.from(useConnections.getState().active));

  const submit = async () => {
    if (sel.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const chosen = databases.filter((n) => sel.has(n));
      // "All" → null so future databases stay visible; a proper subset is
      // stored verbatim. At environment scope the `null` is still recorded as an
      // override (the key stays present), which is how this environment shows
      // everything while the profile keeps a narrower default for the others.
      const value = chosen.length === databases.length ? null : chosen;
      if (scope === "profile") {
        const stored = useConnections
          .getState()
          .profiles.find((p) => p.id === profileId);
        if (stored) {
          await useConnections.getState().save({
            ...stored,
            visible_databases: value,
          });
        }
        // Drop the local override, or the user picks "all environments" and
        // sees nothing change here — the override would keep winning.
        if (hasOverride) {
          useUi.getState().setDatabaseVisibilityFor(profileId, undefined);
          await persist();
        }
      } else {
        // "Show everything here" on top of a connection that already shows
        // everything is an override that overrides nothing — drop the key
        // instead of persisting a no-op that outlives the profile's default.
        const local = value === null && fromProfile === null ? undefined : value;
        useUi.getState().setDatabaseVisibilityFor(profileId, local);
        await persist();
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  /** Discard this environment's override and fall back to the profile's subset. */
  const clearOverride = async () => {
    setSubmitting(true);
    setError(null);
    try {
      useUi.getState().setDatabaseVisibilityFor(profileId, undefined);
      await persist();
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
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {t("schema.selectDatabases.scopeLabel")}
            </span>
            {/* No control at all for an origin-published connection — a
                one-option segmented strip reads as a dead toggle. The hint
                below says why the choice isn't there. */}
            {fromOrigin ? (
              <span className="text-xs font-medium">
                {t("schema.selectDatabases.scopeEnvironment")}
              </span>
            ) : (
              <Segmented
                size="sm"
                aria-label={t("schema.selectDatabases.scopeLabel")}
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "environment" as const,
                    label: t("schema.selectDatabases.scopeEnvironment"),
                  },
                  {
                    value: "profile" as const,
                    label: t("schema.selectDatabases.scopeProfile"),
                  },
                ]}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {fromOrigin
              ? t("schema.selectDatabases.scopeOriginHint")
              : scope === "environment"
                ? t("schema.selectDatabases.scopeEnvironmentHint")
                : t("schema.selectDatabases.scopeProfileHint")}
          </p>
          {hasOverride && (
            <button
              onClick={() => void clearOverride()}
              disabled={submitting}
              className="text-[11px] text-primary underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("schema.selectDatabases.useProfileDefault")}
            </button>
          )}
        </div>
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
      className="flex w-full items-center gap-1 py-1 pl-5 pr-2 hover:bg-accent/30"
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
