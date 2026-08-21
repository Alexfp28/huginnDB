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
  Code2,
  Copy,
  Database,
  Download,
  Eraser,
  ExternalLink,
  Table as TableIcon,
  Eye,
  FolderPlus,
  KeyRound,
  LayoutList,
  PencilLine,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import {
  tableKey,
  useEnsureSchemaLoaded,
  useSchema,
} from "@/stores/session/schema";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { useUi } from "@/stores/session/ui";
import {
  databaseViewId,
  isServerWide,
  tableTabTitle,
} from "@/lib/connectionLabel";
import { usePreferences } from "@/stores/preferences/preferences";
import { api } from "@/lib/tauri";
import { toast } from "sonner";
import { selectSnippet } from "@/lib/grid/copyFormats";
import type { SchemaTableMetric } from "@/types";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { CreateCollectionDialog } from "@/components/schema/dialogs/CreateCollectionDialog";
import { DropObjectDialog } from "@/components/schema/dialogs/DropObjectDialog";
import { EmptyTableDialog } from "@/components/schema/dialogs/EmptyTableDialog";
import { RenameObjectDialog } from "@/components/schema/dialogs/RenameObjectDialog";
import { resolveVisibleDatabases } from "@/lib/connection/visibleDatabases";
import {
  isTooManyConnections,
} from "@/lib/db/driver";
import type { Driver, TableInfo } from "@/types";
import { ExportDatabaseDialog } from "@/components/schema/dialogs/ExportDatabaseDialog";
import { ImportSqlDialog } from "@/components/schema/dialogs/ImportSqlDialog";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { DB_VIEW_WARM_CONCURRENCY } from "@/lib/schema/warmDatabases";
import {
  supportsCreateDatabase,
  supportsDdlEditing,
  supportsRenameTable,
  supportsSqlDump,
} from "@/lib/db/driver";

/**
 * Match a table/database name against the filter box. HeidiSQL-style: the
 * filter may hold several `;`-separated patterns and a name matches when it
 * contains ANY of them (OR), so `users; orders` surfaces both tables at once.
 * An empty filter (or one that's only separators/whitespace) matches all.
 */
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
  // Multi-DB mode: the profile addresses a whole server rather than one
  // database, so the tree grows a database layer. See `isServerWide` for why
  // SQLite is excluded regardless of its `database` field.
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isMultiDb = isServerWide(profile);

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

  // Needed by the context menu to compose a driver-correct "Copy SELECT"
  // snippet.
  const driver = useConnectionDriver(connectionId);

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

  useEnsureSchemaLoaded(connectionId);

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
                          openQueryTab(connectionId)
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
        <RenameObjectDialog
          kind="table"
          connectionId={connectionId}
          target={renameTarget}
          driver={driver}
          databases={cs.databases.map((d) => d.name)}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            // `refreshTree`: a MongoDB rename can move the collection into
            // another database, whose slice is a sibling of this one.
            void useSchema.getState().refreshTree(connectionId);
          }}
        />
      )}
      {dropTarget && (
        <DropObjectDialog
          kind="table"
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
        <RenameObjectDialog
          kind="view"
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
        <DropObjectDialog
          kind="view"
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

  useEnsureSchemaLoaded(parentId);

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
  // `DB_VIEW_WARM_CONCURRENCY` at a time (shared with the palette's own warm —
  // see `lib/schema/warmDatabases.ts`, which also records why that one stays a
  // separate scheduler rather than being merged into this effect);
  // `pumpTick` re-runs this effect as each
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
      if (inFlightPrefetch.current.size >= DB_VIEW_WARM_CONCURRENCY) break;
      const childId = databaseViewId(parentId, db.name);
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
      const childId = databaseViewId(parentId, db.name);
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
      const childId = databaseViewId(parentId, db.name);
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

  /**
   * Refresh what this node actually shows.
   *
   * The tables under a database live in its synthetic
   * `<parent>::db::<db>` slice, so refreshing the *parent* — which is what
   * this menu used to do — re-fetched a table list nobody renders and left
   * the visible subtree exactly as it was. A table created outside the app
   * never appeared, no matter how many times "Refresh" was clicked. Both
   * slices are refreshed: the parent for the database list itself, the child
   * for this database's collections/tables.
   *
   * `resolveChildId` opens the pool when this database has never been
   * expanded, the same lazy-open every other action in this menu does.
   */
  const refreshThisDatabase = async () => {
    const id = await resolveChildId();
    const schema = useSchema.getState();
    await Promise.all([
      schema.refresh(parentId),
      id ? schema.refresh(id) : Promise.resolve(),
    ]);
  };

  // "New query here": open a query tab scoped to *this* database.
  const openQueryHere = async () => {
    const id = await resolveChildId();
    if (!id) return;
    openQueryTab(id);
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
      const droppedId = databaseViewId(parentId, dbName);
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
            onSelect={() => void refreshThisDatabase()}
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
    void navigator.clipboard.writeText(
      selectSnippet(actions.driver, t.schema, t.name),
    );
  };

  const isMongo = actions.driver === "mongodb";
  /** Structure and view editing need a DDL builder for the driver; SQL Server
   *  doesn't have one yet, so it gets the same read-only treatment MongoDB has
   *  — except that its structure *view* is real (see below). */
  const canEditDdl = supportsDdlEditing(actions.driver);
  /** Rename is its own capability: it needs no DDL builder, so MongoDB has it
   *  (`renameCollection`) even though everything above is unavailable there. */
  const canRename = supportsRenameTable(actions.driver);

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
              type="button"
              onClick={() => {
                toggleNode(connectionId, tableNodeKey);
                // Don't auto-relaunch a failed load on every toggle — the
                // retry button below is the explicit way to try again while
                // the error is still showing.
                if (!cols && !colError) loadColumns(connectionId, t.schema, t.name);
              }}
              // Only the chevron toggles the column list now — the rest of
              // the row opens the table in a tab (below). A single click
              // anywhere used to expand columns, which surprised users
              // coming from IDEs where clicking a table row opens it.
              className="-my-1 -ml-1 shrink-0 rounded p-1.5 hover:bg-accent/60"
              aria-label={
                tableOpen ? ct("schema.collapseColumns") : ct("schema.expandColumns")
              }
              title={tableOpen ? ct("schema.collapseColumns") : ct("schema.expandColumns")}
            >
              {tableOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
            <button
              type="button"
              onClick={() =>
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
              className="flex flex-1 items-center gap-1 py-1 text-left"
            >
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
            tree round-trip. No SQL DDL — structure editing is read-only for
            Mongo — but rename *is* offered: `renameCollection` needs no DDL
            builder, and it can move the collection to another database while
            it is at it. */}
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
            {canRename && (
              <ContextMenuAction
                icon={PencilLine}
                label={ct("schema.context.rename")}
                onSelect={() => actions.onRename(t)}
              />
            )}
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
            {/* Its own capability, not `canEditDdl`: rename needs no DDL
                builder, which is why MongoDB has it too (below). */}
            {canRename && (
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

/** Modal for renaming a table. Validates against empty input and
 *  surfaces the backend error in-place. */
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
