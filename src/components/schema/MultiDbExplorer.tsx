/**
 * Multi-DB explorer — for a profile whose `database` is blank. Lists every
 * database the user can see on the server as a top-level node; expanding one
 * lazily opens a synthetic `<parent>::db::<name>` connection
 * (`open_database_view`) and the nested subtree is a regular
 * `SingleDbExplorer` pointed at that synthetic id.
 *
 * Two things here are load-bearing and documented at the site as well:
 *
 * - **Nothing here opens a connection pool on its own.** The cross-database
 *   search prefetch that used to live in this file is gone; warming is an
 *   explicit action on the filter box (`lib/schema/warmForSearch.ts`).
 * - **The `useMemo`s stay above the `if (!cs)` early return**, for the same
 *   hook-count reason `SingleDbExplorer`'s header spells out.
 *
 * **This file no longer owns any part of the search.** It used to debounce the
 * needle itself, compute its own match set over a wide `byConnection`
 * subscription, and keep a hidden second scope (`activeDatabaseName`, set as a
 * side effect of expanding a database). All three now live in the tree: the
 * needle is committed once, counted once, and arrives here already parsed
 * (`patterns`) alongside this connection's `summary`.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  FolderPlus,
  RefreshCw,
  Search,
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
import { scopeIncludesDatabase } from "@/lib/schema/filterScope";
import {
  supportsCreateDatabase,
  supportsDdlEditing,
  supportsSqlDump,
} from "@/lib/db/driver";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { useEnsureSchemaLoaded, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useTreeSearch } from "@/stores/session/treeSearch";
import { useUi } from "@/stores/session/ui";
import type { ConnectionMatchSummary } from "@/lib/schema/treeMatches";
import type { Driver } from "@/types";

export const MultiDbExplorer = memo(function MultiDbExplorer({
  parentId,
  patterns,
  summary,
}: {
  parentId: string;
  /** The committed, parsed needle, forwarded by `SchemaExplorer`. */
  patterns: string[];
  /** This connection's match counts, computed once by the tree. */
  summary?: ConnectionMatchSummary;
}) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[parentId]);
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
  /**
   * The database the user last looked at, as a *visual* accent only.
   *
   * It used to be local state that doubled as a hidden second filter scope:
   * expanding a database silently narrowed the search to it and collapsed its
   * siblings, with nothing on screen saying so. The search no longer reads it
   * at all — the scope is explicit, visible and lives in `useTreeSearch` — and
   * what is left of it moved to `useUi` so the scope affordances and the tree
   * act on one value. Read as a primitive, so the selector is safe (gotcha #1).
   */
  const activeDatabaseName =
    useUi((s) => s.activeDatabaseByConnection[parentId]) ?? null;
  const setActiveDatabase = useUi((s) => s.setActiveDatabase);

  /** The explicit scope, so a narrowed search shows only what it searches. */
  const scope = useTreeSearch((s) => s.scope);
  const narrowTo = useTreeSearch((s) => s.narrowTo);
  const requestSearchFocus = useTreeSearch((s) => s.requestFocus);

  useEnsureSchemaLoaded(parentId);

  const filterActive = patterns.length > 0;

  // No eager warm on connect: with many databases (a server with 19+ is
  // common) precaching every child's table list made the initial load
  // noticeably slow, and the DataGrip-style visible-databases selector (#64)
  // plus lazy expand already give the user control over what actually loads.
  //
  // Nor any warm while *typing*. This file used to run a bounded prefetch off
  // the debounced needle, so a search reached databases nobody had opened —
  // at the cost of a connection pool per database, driven by a keystroke.
  // Searching now looks only at what is already in `useSchema`, and reaching
  // further is an explicit action on the filter box (`warmForSearch`). A
  // freshly connected server is therefore "cold" until asked, and the tree
  // says so rather than reporting a `0` it cannot back up.

  /**
   * Which database rows to render, and what each one knows about itself.
   *
   * With no filter that is simply the visible subset. With one, a database
   * earns its row by containing a match, by its own name matching, or by being
   * cold — we have not read it, so hiding it would be claiming it is empty.
   *
   * This memo MUST live above the early return below: React relies on hooks
   * being called in the same order on every render, so a conditional
   * `if (!cs) return …` above it would skip the hook on the first render and
   * call it on subsequent ones — a Rules of Hooks violation that blanked the
   * whole multi-DB panel in 0.7.0 / 0.7.1 (no error UI, just an empty tree).
   */
  const dbRows = useMemo(() => {
    const visible = (cs?.databases ?? [])
      .filter((db) => !visibleSet || visibleSet.has(db.name))
      // A database scope on *this* connection hides its siblings, even before
      // anything is typed: "search here only" that still lists everywhere
      // would be a strange thing to look at. A scope naming a *different*
      // connection deliberately does not touch this list — narrowing the
      // search elsewhere must not blank out an unrelated server's databases;
      // that connection's own row already dims and folds while a search is
      // running (`out-of-scope`).
      .filter(
        (db) =>
          scope.kind !== "database" ||
          scope.connectionId !== parentId ||
          scopeIncludesDatabase(scope, parentId, db.name),
      );
    if (!filterActive) {
      return visible.map((db) => ({ db, count: 0, cold: false, nameMatch: false }));
    }
    const cold = new Set(summary?.coldDatabases ?? []);
    const nameMatches = new Set(summary?.databaseNameMatches ?? []);
    return visible.flatMap((db) => {
      const count = summary?.byDatabase.get(db.name) ?? 0;
      const isCold = cold.has(db.name);
      const nameMatch = nameMatches.has(db.name);
      if (count === 0 && !isCold && !nameMatch) return [];
      return [{ db, count, cold: isCold, nameMatch }];
    });
  }, [cs?.databases, visibleSet, filterActive, summary, scope, parentId]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  /**
   * Note the database a table was just opened from, for the brand accent.
   *
   * It used to also collapse every *other* expanded database, on the theory
   * that the user was now working in this one. While a search is running that
   * is exactly wrong — the whole point is that results from several databases
   * are on screen at once — so the sibling collapse is skipped in that case.
   */
  const activateDb = (dbName: string) => {
    setActiveDatabase(parentId, dbName);
    if (filterActive) return;
    for (const key of cs.expanded) {
      if (key.startsWith("db:") && key !== `db:${dbName}`) {
        toggleNode(parentId, key);
      }
    }
  };

  return (
    <div className="flex flex-col">
      {visibleSet && (
        <div className="px-3 pb-2">
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
        {/* Only ever said about databases we have actually read: a cold one
            still gets a row, so `dbRows` being empty means every visible
            database reported and none of them matched. This is the line the
            old `prefetching` flag could never let through once a
            visible-databases subset was active. */}
        {filterActive && dbRows.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {dbRows.map(({ db, count, cold, nameMatch }) => (
          <DatabaseRoot
            key={`${parentId}::${db.name}`}
            parentId={parentId}
            dbName={db.name}
            driver={driver}
            canDrop={canCreateDatabase}
            expanded={cs.expanded.has(`db:${db.name}`)}
            onToggle={() => toggleNode(parentId, `db:${db.name}`)}
            onScopeHere={() => {
              narrowTo({ kind: "database", connectionId: parentId, database: db.name });
              requestSearchFocus();
            }}
            onTableOpen={() => activateDb(db.name)}
            patterns={patterns}
            filterActive={filterActive}
            // Auto-expand databases that contain a table match so the result
            // is visible immediately. A name-only match keeps the database
            // collapsed — the user is presumably picking the database, not
            // browsing inside it — and a cold one has nothing to show yet.
            autoExpand={count > 0}
            matchCount={filterActive && !cold ? count : null}
            cold={cold}
            nameMatch={nameMatch}
            active={activeDatabaseName === db.name}
            // Only dim siblings when a concrete database is the accent. With
            // none, every database is equally in play and dimming would be
            // misleading.
            dimmed={activeDatabaseName != null && activeDatabaseName !== db.name}
          />
        ))}
      </div>
    </div>
  );
});

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
  onScopeHere,
  onTableOpen,
  patterns,
  filterActive,
  autoExpand,
  matchCount,
  cold,
  nameMatch,
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
  /** Narrow the tree's search to this database (explicit, from the menu). */
  onScopeHere: () => void;
  /** Called when the user opens a table inside this DB. */
  onTableOpen: () => void;
  /** The committed, parsed needle, forwarded to the nested explorer. */
  patterns: string[];
  /** True when the parent filter has any content; auto-expands already-opened
   *  databases so search results surface without an extra click. */
  filterActive: boolean;
  /** True when the parent has determined this DB contains a table match
   *  for the current filter — auto-opens the subtree (Compass-style). */
  autoExpand?: boolean;
  /** Matches inside this database, or `null` when there is nothing to say
   *  (no filter, or the database has never been read). */
  matchCount: number | null;
  /** True when this database's table list has never been fetched. */
  cold: boolean;
  /** True when the database's own name is what matched. */
  nameMatch: boolean;
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
            // Expanding a database used to *also* narrow the filter to it and
            // collapse its siblings, invisibly. Now it only expands: the scope
            // is a separate, deliberate gesture ("Search here only", below).
            onClick={onToggle}
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
            <span
              className={cn(
                "truncate text-xs",
                nameMatch && "font-medium text-foreground",
              )}
            >
              {dbName}
            </span>
            {filterActive && (
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-sm px-1 text-[10px] leading-4 tabular-nums",
                  // A cold database says "—", never "0": nobody has read it,
                  // and a provisional zero is what makes a search look failed.
                  matchCount === null
                    ? "bg-muted text-muted-foreground/60"
                    : matchCount > 0
                      ? "bg-brand/15 text-brand"
                      : "bg-muted text-muted-foreground/60",
                )}
                title={cold ? t("connectionsTree.filter.counting") : undefined}
              >
                {matchCount ?? "—"}
              </span>
            )}
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
          <ContextMenuAction
            icon={Search}
            label={t("connectionsTree.filter.scopeHere")}
            onSelect={onScopeHere}
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
              patterns={patterns}
              onTableOpen={onTableOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}
