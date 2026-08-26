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
 * `<parentId>::db::<db>` connection in the backend (see `open_database_view`),
 * and every nested node uses that synthetic id so downstream commands like
 * `list_tables` / `fetch_table_data` keep their existing
 * single-connection-id signatures.
 *
 * This file is only the entry point: it picks which of the two explorers to
 * render and puts the shared origin notice above whichever one it is. The
 * subtree itself lives in `SingleDbExplorer` / `MultiDbExplorer`, and the rows
 * under them in `SchemaTableSection` / `SchemaTableRow`.
 */

import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { MultiDbExplorer } from "@/components/schema/MultiDbExplorer";
import { SingleDbExplorer } from "@/components/schema/SingleDbExplorer";
import { isServerWide } from "@/lib/connectionLabel";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionMatchSummary } from "@/lib/schema/treeMatches";

export function SchemaExplorer({
  connectionId,
  patterns,
  summary,
}: {
  connectionId: string;
  /**
   * The committed, parsed needle from the tree-level filter box
   * (`ConnectionsTree.tsx`). Every live connection gets the same array — the
   * box searches all of them — and its identity is stable between commits, so
   * the memos below can depend on it directly.
   */
  patterns: string[];
  /**
   * This connection's already-computed match counts. Passed down rather than
   * recomputed because the tree holds the app's single subscription to
   * `useSchema.byConnection` (see `useTreeMatchCounts`); a multi-DB explorer
   * that re-derived them would be a second wide subscription per connection,
   * which is what this replaces.
   */
  summary?: ConnectionMatchSummary;
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
    // Anything bound at `tree` scope is only audible from inside the explorer.
    <div className="flex flex-col" data-kb-scope="tree">
      <VanishedOriginNotice profileId={connectionId} />
      {isMultiDb ? (
        <MultiDbExplorer
          parentId={connectionId}
          patterns={patterns}
          summary={summary}
        />
      ) : (
        <SingleDbExplorer connectionId={connectionId} patterns={patterns} />
      )}
    </div>
  );
}
