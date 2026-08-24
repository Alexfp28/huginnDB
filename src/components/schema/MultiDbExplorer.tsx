/**
 * Multi-DB explorer — for a profile whose `database` is blank. Lists every
 * database the user can see on the server as a top-level node; expanding one
 * lazily opens a synthetic `<parent>::db::<name>` connection
 * (`open_database_view`) and the nested subtree is a regular
 * `SingleDbExplorer` pointed at that synthetic id.
 *
 * Two things here are load-bearing and documented at the site as well:
 *
 * - **The cross-database search prefetch is bounded**, and its own comment
 *   explains why (each database view is a whole connection pool). See
 *   `DB_VIEW_WARM_CONCURRENCY` in `lib/schema/warmDatabases.ts`, which also
 *   records why the palette's warm stays a separate scheduler.
 * - **The `useMemo`s stay above the `if (!cs)` early return**, for the same
 *   hook-count reason `SingleDbExplorer`'s header spells out.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  FolderPlus,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";
import { notify } from "@/lib/notify";

import { SingleDbExplorer } from "@/components/schema/SingleDbExplorer";
import {
  CreateCollectionDialog,
} from "@/components/schema/dialogs/CreateCollectionDialog";
import {
  ExportDatabaseDialog,
} from "@/components/schema/dialogs/ExportDatabaseDialog";
import { ImportSqlDialog } from "@/components/schema/dialogs/ImportSqlDialog";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { useVisibleDatabases } from "@/lib/connection/useVisibleDatabases";
import { databaseViewId } from "@/lib/connectionLabel";
import {
  isTooManyConnections,
  supportsCreateDatabase,
  supportsDdlEditing,
  supportsSqlDump,
} from "@/lib/db/driver";
import { matchesFilter } from "@/lib/schema/matchesFilter";
import { DB_VIEW_WARM_CONCURRENCY } from "@/lib/schema/warmDatabases";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { useEnsureSchemaLoaded, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import type { Driver } from "@/types";

export function MultiDbExplorer({
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
            notify.error(String(e), {
              actions: [{
                label: t("schema.releaseIdlePools"),
                variant: "primary",
                onClick: () => {
                  void api
                    .releaseIdlePools()
                    .then((closed) => {
                      notify.success(
                        t("schema.releasedIdlePools", { count: closed }),
                      );
                      setLimitReached(false);
                    })
                    .catch((err) => notify.error(String(err)));
                },
              }],
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
            notify.success(t("schema.createCollection.created", { name }));
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
