# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

### Added

- **MongoDB list view.** Collection tabs for a `mongodb` connection now offer
  a table/list toggle in the toolbar (only shown for that driver — every
  other driver keeps rendering as a table). List mode renders each document
  as a card with one `field: value` line per top-level column instead of one
  column per field, which was the actual pain point: a document with many
  fields, or with a nested object/array value, forced constant horizontal
  scrolling in table mode and flattened the nested value into a single-line
  JSON blob that was hard to read. List mode pretty-prints nested
  objects/arrays with indentation instead. It's deliberately read-only for
  this first pass — no inline cell editing, no insert/duplicate draft row —
  since those need the table's editable-row UI; per-row "Copy as JSON" and
  "Delete" still work directly from the card, since neither needs it. The
  chosen mode is a single global preference (`grid.documentViewMode` in
  `prefs.json`, also exposed in Settings → Grid), not per-collection — same
  tier as `rowHeight` or `bitDisplay` — so switching once applies to every
  MongoDB collection you open afterwards.

- **Reconnect on launch.** A new General preference (default on) makes the
  main window automatically reconnect, at startup, to the connections that
  were live when it was last closed — using the credentials already in the
  OS keychain. Previously the app opened disconnected and you had to
  reconnect to each host by hand (and, because of the layout bug below, in
  the *right order*) to get your workspace back. Connections whose password
  isn't stored, or whose host is unreachable, are skipped without blocking
  startup; the toggle lets you opt out entirely. The launch state — which
  connections were live, which one was focused, and which tab was active — is
  persisted on graceful close and opportunistically on each
  connect/disconnect, so the workspace comes back the way you left it (same
  connection in focus, same tab, same pane layout) regardless of the order the
  pools happen to reopen, and even an abrupt exit leaves something to restore.

- **Canary build channel.** A new opt-in pre-release channel lets a change be
  dogfooded against real production connection profiles *before* it ships in a
  stable release — no full release required. A canary build (compiled with the
  new `canary` Cargo feature, paired with `src-tauri/tauri.canary.conf.json`)
  installs side-by-side with the stable app: it has its own bundle identifier
  (`io.huginndb.canary`), product name ("HuginnDB Canary"), and a separate
  auto-updater feed, and it isolates all of its on-disk state into a dedicated
  `HuginnDB-Canary` config directory. That isolation means a canary can safely
  exercise destructive, one-way on-disk migrations without ever touching the
  stable install's `profiles.json` / `tab_state.json` / `prefs.json`. The OS
  keychain service is deliberately *shared*, so the canary reuses the passwords
  the stable build already stored rather than forcing them to be re-entered.
  Builds are produced by a manual `canary` GitHub Actions workflow from any
  branch or commit and published to a single rolling `canary` release; see
  `docs/CANARY.md`.

- **Sandbox indicator for the canary build.** Because the canary shares the UI
  bundle (and the OS keychain) with the stable app, once you were *inside* the
  window the two were indistinguishable — easy to mistake the sandbox for your
  real install. The canary build now makes its identity unmistakable: a
  persistent amber "SANDBOX · HuginnDB Canary" ribbon pinned above the header
  (with the isolated state dir called out), a "CANARY" badge next to the
  header brand, a flavor-aware OS window title ("HuginnDB Canary" in the
  taskbar / Alt-Tab, which the frontend previously overwrote back to
  "HuginnDB"), and an About panel that shows the canary product name and its
  real `HuginnDB-Canary` state paths. The stable build is visually unchanged.
  A new `get_app_flavor` command exposes the compile-time `canary` feature to
  the frontend, since the two builds ship an identical JS bundle.

### Changed

- **The row-count no longer blocks the first rows from appearing, and a
  whole-table count is now an instant estimate.** Opening a table/collection
  used to compute the data page *and* an exact `COUNT(*)` (`count_documents`
  on MongoDB) in a single round trip, returning nothing to the grid until
  both finished. On a multi-million-row table the count dominated, so the
  first paint waited seconds on a query whose 100 rows were already in hand —
  exactly the "Compass feels faster" report in issue #77. The count is now a
  separate request (`count_table_rows`) fired alongside the data fetch: rows
  render as soon as the `SELECT`/`find` returns, and the footer fills in
  "/ N" when the count arrives (paging still works in the meantime). For a
  whole-table browse (no filters, no search) the total comes from the
  engine's O(1) statistics — `pg_class.reltuples` on Postgres,
  `information_schema.TABLE_ROWS` on MySQL, `estimatedDocumentCount` on
  MongoDB — and is shown as an approximate `~N` (hover for the tooltip). A
  never-analysed table (or SQLite, which has no cheap estimate) falls back to
  an exact count. Any active filter/search forces an exact count of the
  matching subset, but it still runs off the render's critical path. The
  headless `huginndb-mcp` `browse_table` tool is unchanged (it keeps the
  inline exact count).

- **Table-tab toolbar re-laid-out for a cleaner filter cluster.** The top
  toolbar of a table/collection tab previously crowded four different concerns
  into its left edge — the reload button, the advanced-filter button, the
  MongoDB table/list view toggle, and a cramped fixed-width (`w-56`) search
  box — which read as an undifferentiated pile. The bar is now split into a
  coherent *filter* group on the left (refresh · advanced filter · search box)
  and a *display* group pinned to the right (row count · Insert · view toggle ·
  elapsed time). The search box is the visual anchor: it grows to fill the
  available width (capped, with a leading magnifier icon) instead of the old
  narrow fixed size, so filtering — the toolbar's primary action — no longer
  feels like an afterthought. The MongoDB view toggle moved from the filter
  cluster to the display group, since choosing table-vs-list is a display
  concern, not a filter. No behaviour changed — same actions, same shortcuts,
  purely a layout/affordance pass. Implemented via a new `toolbarTrailing`
  slot on `DataGrid` mirroring the existing `toolbarLeading`.

- **The workspace pane layout is now session-level, not per-connection.**
  The inner-dockview split/float geometry (how you've arranged the open
  table/query tabs) used to be stored redundantly under *every* connection
  in `tab_state.json`, even though a single inner dockview hosts all
  connections' tabs at once. On restore, whichever connection you happened
  to connect to first won — so the layout only came back if you reconnected
  in a specific order. It's now stored once at the top level of
  `tab_state.json` and restored a single time at launch, independent of
  connection order. Existing per-connection layouts are migrated
  automatically on first load after upgrading (the most-recently-used one is
  promoted to the session layout), so nobody loses their arrangement.

- **"Float in new window" now opens a real, independent OS window.** A tab's
  "Sacar a ventana flotante" action used to call dockview's
  `addFloatingGroup`, which only detaches the panel *within* the inner
  workspace's own bounds — the floating panel could be dragged around, but
  never past the edges of the workspace pane it came from, which defeated the
  point when you wanted, say, the cell editor free of the table view
  entirely. It now opens a bare, native `WebviewWindow` (`open_tab_window`,
  rendered by the new `DetachedTabWindow` root) that hosts just that one
  tab — no sidebar, no other tabs, no menus — and can be moved anywhere on
  the desktop like any other window. The tab is removed from the main
  window's workspace the moment it's popped out, so closing the detached
  window is simply the tab's close: there's no state to reconcile back.
  Applies to every tab kind (table, query, structure, view, security). Like
  "New window", these windows are ephemeral — they don't touch
  `tab_state.json` and aren't restored across restarts.

### Fixed

- **Double-clicking a cell's text no longer fails to enter inline-edit
  mode.** Since the "expand" icon landed (#78), a selected cell also grows a
  `ring-2 ring-inset ring-brand` border on the `<td>` itself, occupying the
  cell's edge/padding area alongside the value. On the Linux WebKitGTK
  webview, double-clicking directly over the value's text intermittently
  never fired the native `dblclick` event at all — a known WebKitGTK quirk
  where `user-select: none` (set table-wide, see `DataGrid.tsx`'s
  `select-none` note) suppresses `dblclick` specifically when there's
  selectable text under the pointer, while double-clicking the cell's empty
  padding (no text glyph under the cursor, which is what made it *look*
  like clicking "the border" was the trick) worked fine. The `<td>`'s
  `onClick` handler now also checks the native `click` event's own
  `detail` (the OS click count, unaffected by that quirk): a second click
  (`e.detail >= 2`) routes straight into `openCellEdit`, the same path
  `onDoubleClick` already used — so edit mode now opens reliably regardless
  of exactly where in the cell the double-click lands.

- **Typing into an inline cell edit no longer kicks the caret to the end
  of the value on every keystroke.** `DataGrid`'s `columns` memo listed
  `inlineEdit` (and `fkEditCell`/`selectedCell`) in its dependency array, so
  every keystroke — which updates `inlineEdit.value` — rebuilt the entire
  `columns` array, handing every column's `cell` renderer a brand-new arrow
  function reference. TanStack's `flexRender` treats `columnDef.cell` as a
  component *type* (`typeof Comp === "function"` → `React.createElement(Comp,
  props)`), so a new reference each render reads to React as a different
  element type for every cell in the grid — forcing a full unmount +
  remount of the whole table body, including whatever `<input>` was mid-edit.
  A freshly-mounted `autoFocus` input always plants its caret at the end,
  which is exactly what made moving the cursor mid-value and continuing to
  type impossible without retyping the whole thing. `fkEditCell`/
  `inlineEdit`/`selectedCell` are now mirrored into a `useRef` updated on
  every render instead of being memo dependencies; each column's `cell`
  function reads the live values off that ref, so its own identity — and the
  mounted DOM underneath it — stays stable across keystrokes.

- **Secondary windows ("New window") can now rearrange their panels.**
  Dragging a panel in a window opened via the Window menu always showed the
  "not-allowed" cursor: the window was built without the main window's
  `dragDropEnabled: false` setting, so Tauri's OS-level drag-drop handler
  stayed on and swallowed the HTML5 drag events dockview relies on. The
  secondary-window builder now disables that native handler, matching the
  main window exactly.

## [1.10.0] — 2026-07-23

### Added

- **Views can now be created, edited, renamed and dropped from the schema
  explorer (#86).** Until now a view showed up in the tree read-only —
  its context menu offered only Open / Copy name / Copy SELECT / Refresh,
  with every DDL action explicitly gated off (`!isView` in
  `SchemaExplorer.tsx`), and the backend had no query to even read a view's
  definition (`pg_get_viewdef` / `information_schema.views` /
  `sqlite_master.sql` were never called). The only way to touch a view was
  to hand-write `CREATE OR REPLACE VIEW` in the query editor — exactly the
  HeidiSQL-style raw-SQL experience the maintainer wanted to avoid,
  especially for views with several JOINs where it's hard to tell what
  columns/rows the definition actually produces just by reading the SQL.
  Rather than build a full visual join/query builder (roadmap item 9,
  explicitly low priority), the new "Edit view…" tab pairs a full-size
  Monaco SQL editor for the view body — with the same schema-aware
  autocomplete as the query editor — with a live, debounced "preview
  results" grid that runs the current draft (wrapped in a `LIMIT`-ed outer
  `SELECT`) so the actual columns and rows a JOIN produces are visible
  while typing, plus a read-only DDL pane (same pattern as the table
  structure editor) showing the exact statements Apply will run. New
  backend module `db/view_ddl.rs` builds driver-aware DDL from a diffed
  `ViewDefinition`: `CREATE OR REPLACE VIEW` on Postgres/MySQL (with an
  explicit `ALTER VIEW … RENAME TO` / `RENAME TABLE` first when the name
  changed), and always drop+recreate on SQLite (no `CREATE OR REPLACE
  VIEW` / `ALTER VIEW` there) — informational only in the UI, since a view
  holds no data of its own to lose. Five new Tauri commands
  (`get_view_definition`, `preview_view_change`, `apply_view_change`,
  `rename_view`, `drop_view`) mirror the existing
  `get_table_structure`/`preview_structure_change`/`apply_structure_change`
  shape. MongoDB is excluded in this version, same as table-structure
  editing — its "views" are read-only aggregation-pipeline collections
  with a fundamentally different edit model (`collMod`/`createView`).
  
- **A `between` operator in the Advanced Filter, unifying range filtering across
  every driver (#81).** The advanced-filter builder already offered
  `contains`/`not_contains`/`starts_with`/`ends_with` consistently on Postgres,
  MySQL, SQLite and MongoDB (verified while investigating this issue — MySQL's
  `contains` was already working via the shared `CAST(col AS CHAR) LIKE`
  path), but no operator existed to filter an inclusive range in one
  condition; a user had to stack a `gt`/`gte` row and a `lt`/`lte` row instead.
  `FilterOp::Between` is now a single shared variant consumed by
  `build_filter_clause` (SQL: `col BETWEEN ? AND ?` / `BETWEEN $N AND $N+1`)
  and Mongo's `build_filter` (`{ $gte, $lte }`), backed by a new `value2`
  field on `ColumnFilter` (added on both the Rust struct and its TypeScript
  mirror — a value dropped silently by serde otherwise, see gotcha #14). The
  dialog offers it alongside `gt`/`gte`/`lt`/`lte` for numeric/date columns
  and renders a second "to" input when selected.

- **A single click now shows a direct "expand" icon on the selected cell,
  so its full value can be viewed without first double-clicking into edit
  mode (#78).** Previously the only way to view a long cell's untruncated
  content was to double-click, which for an editable cell also entered
  inline-edit mode — an unwanted side effect when the user only wanted to
  *read* the value. The `DataGrid` cell renderer's plain (non-editing)
  branch now checks whether the cell matches `selectedCell` (set on plain
  single click, compared by the same `rowValues`/`row.original` referential
  identity used everywhere else in the grid — see gotcha #7) and, if so,
  renders a small `Maximize2` button next to the value. Clicking it calls
  the existing `openHeavyEditor`, unchanged, so it already honours the
  user's `cellEditorMode` preference (modal vs. docked side panel) exactly
  like the inline editor's own expand button and the cell-preview panel's
  fullscreen button do. The icon appears uniformly for text, FK and BIT
  columns, and for read-only query results — it is purely a value viewer,
  never an editor, so no column type needs excluding.

- **Ctrl+C / Ctrl+V now work on the selected data-grid cell (#79).**
  `handleGridKeyDown` used to deliberately ignore every Ctrl/Cmd-modified
  key chord (to avoid interfering with the browser's own copy/paste), which
  meant Ctrl+C over a cell copied nothing, since a `<td>` has no native text
  selection to copy from. Ctrl+C and Ctrl+V are now special-cased ahead of
  that blanket guard: Ctrl+C copies the raw value of the mouse-selected cell
  (falling back to the keyboard-navigated active cell when nothing has been
  clicked) via the same `copyToClipboard` helper the right-click "Copy"
  context-menu item already uses. Ctrl+V reads `navigator.clipboard`, and
  seeds `inlineEdit` with the pasted text instead of the cell's current
  value — reusing the exact same `CellInput` commit/cancel flow as a normal
  double-click edit, so Enter/blur saves the pasted value and Escape
  discards it. FK and BIT columns have no free-text control to paste into
  (they use a combobox / `<select>` instead), so paste is a deliberate
  no-op there for now; copy still works on every column type.

- **Keyboard shortcuts are now customizable from Settings → Shortcuts
  (#75), unblocking the hotkey half of #78.** Issue #78 asked for a hotkey
  alternative to the expand-icon added above, since the icon's low contrast
  makes it easy to miss — but explicitly deferred that to #75 first. Six
  actions are now rebindable: `openSettings` (Ctrl/Cmd+,),
  `toggleCommandPalette` (Ctrl/Cmd+K), `toggleTabSwitcher` (Ctrl/Cmd+P),
  `refreshData` (F5 — Ctrl/Cmd+R remains a permanent, non-rebindable alias,
  since suppressing the WebView's native reload is a safety necessity, not
  a preference), `runQuery` (Ctrl+Enter), and the new `expandSelectedCell`
  (default `Space`, mirroring macOS Quick Look — confirmed unbound in
  `handleGridKeyDown` today, so it lands with zero collision). Overrides
  persist through `prefs.json` as a new `keybindings` map (action id →
  combo string), following the exact pattern already used by `grid`/`editor`/
  `ui` prefs — an empty map is a fully valid state, since the frontend's new
  `ACTIONS` table in `lib/keybindings.ts` is the single source of truth for
  defaults. `App.tsx`'s global `keydown` listener and `DataGrid`'s
  `handleGridKeyDown` now match against the live binding via a shared
  `matchesBinding` helper instead of hardcoded `e.key`/`e.ctrlKey` checks —
  which incidentally fixes a latent bug where `Ctrl+Shift+K` was
  indistinguishable from plain `Ctrl+K` (no branch checked `shiftKey`).
  Monaco's `editor.addCommand`, used for `runQuery`/`toggleCommandPalette`/
  `toggleTabSwitcher` inside the SQL and view editors, resolves a fixed
  keybinding bitmask once at registration time with no way to re-check a
  live combo — so those three moved to `editor.onKeyDown`
  (`registerEditorActionRedispatch` in the new `lib/monacoKeybindings.ts`),
  which reads the current binding from the store on every keystroke. The
  Settings UI (`ShortcutsSection`/new `ShortcutRow`) replaces the old
  read-only placeholder: clicking a row enters a "press a key…" capture
  mode (Escape always cancels rather than becoming the binding), a rebind
  that collides with another action's combo is rejected inline instead of
  silently swapping or unbinding anything, and each row plus a "Reset all"
  button can restore the default. `expandSelectedCell` reuses the exact
  same `resolveTargetCell()`/`openHeavyEditor()` pair the expand icon's
  click handler already calls, so the icon and the hotkey converge on one
  escalation path. Also bumped both expand icons'
  (`DataGrid`/`CellInput`) contrast from `text-muted-foreground/50` to
  `/80` so the icon added in #78 doesn't require a hover to notice.

### Fixed

- **MySQL spatial columns (`POINT`, `MULTIPOINT`, …) were misclassified as
  numeric by the Advanced Filter**, because `isNumericType`'s substring check
  for `"int"` also matches inside the word `"point"`. Those columns lost
  `contains`/`starts_with`/`ends_with` and gained meaningless `>`/`<`
  comparisons. Found while auditing operator unification for #81; fixed by
  excluding the `"point"` substring from the `"int"` check.

- **The MCP connector's write tools could be forced into read-only for a
  MongoDB database they had explicit `data`/`full` access to.** Reported by a
  user hitting `has MCP write policy "read-only"` on `update_cell` against a
  connection whose Settings → MCP level was actually `data`. The write gate
  (`Huginn::require_class`) was checking the policy against
  `resolve_mongo_target`'s *resolved* pool id rather than the real profile id.
  For a multi-database Mongo connection (empty top-level `database` — the
  common case, since HuginnDB doesn't require picking one at connect time), a
  tool call naming a `schema`/`database` resolves to the synthetic
  per-database id `<connection_id>::db::<name>` so it can address the right
  live pool — but that synthetic id is never a key in `profiles.json`, so the
  policy lookup silently missed and fell back to the default `ReadOnly`,
  regardless of what the connection was actually configured to. `run_query`,
  `insert_row`, `update_cell` and `delete_rows` now gate on `a.connection_id`
  (the real profile id) instead of the resolved target; the resolved target
  is still used, as before, to find the right pool. Added a regression test
  reproducing the exact scenario (a `data`-policy Mongo connection with no
  default database, addressed via `schema`).

- **`updateMany`/`updateOne` rejected an aggregation-pipeline update
  (`db.coll.updateMany(filter, [{ $set: {...} }])`)** with `argument 2 must be
  a document`, even though the underlying `mongodb` driver has supported
  pipeline-style updates since server 4.2. The mongosh-style parser
  (`db/mongo/shell.rs`) only ever built a plain `Document` for the `update`
  argument. It now accepts either shape — a new `UpdateSpec` enum
  (`Document` | `Pipeline`) mirroring `mongodb::options::UpdateModifications`
  — so pipeline updates (e.g. `$replaceAll`/`$toUpper`/computed field values
  that reference other fields) work through `run_query` the same as they do
  in `mongosh`.

### Security

- **Manually verified the MCP connector's write-policy gate end-to-end
  against a real profile set, using an actual AI client (Claude Code driving
  `huginndb-mcp`) rather than a unit test.** `list_connections` was called
  first, read-only (no state touched): of every exposed connection —
  production databases and real client sandboxes included — exactly one
  (an internal ITBacking test server) carried `mcp_write: "data"`; every
  other connection sat at the safe `read-only` default, exactly as
  `McpWritePolicy::default()` (`state.rs`) guarantees for any profile that
  never had a level explicitly raised in Settings → MCP. An `insert_row`
  call was then attempted against that one `data`-policy connection, on a
  connection-less config table (no customer data, no foreign keys) — the
  lowest-risk target available — as a full round-trip check (insert, verify,
  update, delete, leaving no residue). The write never reached
  `Huginn::require_class`: Claude Code's own tool-permission layer (the
  client driving the MCP session, not code in this repo) intercepted the
  call and withheld it pending explicit user authorization, even though the
  server-side policy would have allowed it. This confirms the two gates are
  independent and both intact — a permissive per-connection `mcp_write`
  policy is necessary but not sufficient; the calling AI client's own
  action-approval prompt is a second, separate backstop, not a
  redundant/interchangeable one. No code changes resulted; this is a release
  checklist entry, not a fix.

## [1.9.1] — 2026-07-22

### Fixed

- **Running a single INSERT/UPDATE/DELETE showed no feedback (#82).** The
  query editor's single-statement path (`Ctrl+Enter`) rendered a columns-less
  DML result straight into `DataGrid`, which has nothing to draw for it — the
  results panel just looked empty, with no error and no row count. Only the
  multi-statement batch path ever showed a "rows affected" summary. A DML
  result (no columns) now shows a small "N rows affected · Xms" banner
  instead, on every SQL driver — this wasn't actually MySQL-specific, just
  more likely to be noticed there.

- **The MCP connector's write tools could make new client sessions see zero
  tools (#83).** The write-mode tools added for `insert_row`, `update_cell`
  and `delete_rows` introduced JSON-schema shapes never used before in this
  server's `tools/list` output: a nested struct hoisted into `$defs`/`$ref`,
  and PK-value fields whose per-item schema was the bare boolean `true`
  (schemars' representation of "any JSON value"). Both are valid JSON Schema,
  but an MCP client whose `tools/list` ingestion assumes every schema node is
  a plain object can throw on them — and if that ingestion wraps the whole
  tool list in one try/catch, a single malformed-for-that-client schema
  silently drops all 12 tools for the session, while the server's own log
  (which only reflects what it sent) looks perfectly healthy. The three
  tools' schemas are now inlined and hand-constrained to
  `string | number | boolean | null`, with a regression test asserting no
  `$ref`/`$defs`/bare-boolean subschema ever reappears.

- **Expanding a same-named database under a different connection could leak
  the previous connection's data (#76).** The multi-database schema tree
  keyed its `DatabaseRoot` nodes by database name alone; because nothing
  remounts that tree when the active connection changes, React reused the
  same component instance — and its locally-cached pool id — for two
  different connections that both happened to expose a database with the
  same name (e.g. a `shop` database on both a MySQL and a MongoDB profile).
  The second connection's node kept rendering the first connection's tables.
  The node is now keyed by connection + database name together, so switching
  connections always gets a fresh instance.

- **Window/split layout and in-progress tab edits could be lost on close
  (#80).** No window-close hook ever flushed the debounced tab/layout state
  to disk, and a pure split/float/resize gesture didn't schedule a save at
  all (only a tab or schema change did) — so a normal window close, not just
  a crash, could drop the last ~600ms of edits, including split-panel
  geometry set up moments earlier. Closing the main window now flushes every
  active connection's tab state synchronously first, and layout changes
  schedule a save the same way tab changes already did.

- **MongoDB activity never reached the Console.** Browsing a collection
  (`fetch_table_data`) and running a multi-statement mongosh batch
  (`execute_batch`) both delegated straight to the Mongo driver module
  without ever building a log entry — unlike the single-statement path,
  insert/update/delete, which already logged correctly. Every other driver
  logged every read and write; MongoDB only logged writes issued one
  statement at a time. Collection browsing now logs a reconstructed
  `db.<collection>.find(filter).sort().skip().limit()` line (there's no
  literal statement to echo the way a hand-typed one has), and each
  statement in a mongosh batch logs individually, same as the SQL batch path.

- **The advanced filter builder silently returned nothing on MongoDB when
  filtering a numeric (or boolean) field.** The right-click "Filter by this
  value" chip sends the cell's already-typed value (e.g. the JS number
  `183`), but the advanced-filter dialog's value input is a plain text box —
  it always sent the typed-in text as a JSON string. Postgres/MySQL/SQLite
  don't notice: an unbound parameter's type is inferred from the column it's
  compared against, so a text `"183"` still matches an `integer` column.
  MongoDB's equality is exact-BSON-type, though, and a `string` `"183"`
  never matches a stored `int32` 183 — so the identical filter that worked
  from the context menu returned zero rows from the dialog. The dialog now
  coerces the typed value to a number/boolean based on the column's type
  before applying the filter (substring-match operators — contains/starts
  with/ends with — keep the raw text, since those are always a text/regex
  match regardless of column type).

## [1.9.0] — 2026-07-20

### Fixed

- **Console logs leaked across windows (#50).** With a second window open (the
  "New window" action), every window's Console showed every other window's
  SQL and connection entries. The backend already targeted log events at the
  originating window, but the frontend listener wasn't scoped, so Tauri
  delivered all of them to every window. Each window's Console now shows only
  its own activity; genuinely global notices (like a shared connection dropping)
  still reach every window.

- **MySQL boolean columns showed `NULL` instead of their value (#68).** A
  `TINYINT(1)` / `BOOL` / `BOOLEAN` column is reported by the driver under the
  type name `BOOLEAN`, which the value decoder didn't recognise as an integer —
  so every boolean cell fell through to a text decode that isn't valid for the
  column and collapsed to `NULL`. Boolean columns now render their stored value
  (`0` / `1`), like any other integer.

### Added

- **Advanced per-column filter (#66).** A new filter button in the data-grid
  toolbar opens a builder where you add conditions per column — column →
  operator → value — all combined with AND and applied server-side. Operators
  are type-aware: text columns offer contains / does-not-contain / starts-with
  / ends-with, numeric and date columns offer ordered comparisons
  (>, ≥, <, ≤), and every column offers equals / not-equals / is-null /
  is-not-null. Works across Postgres, MySQL, SQLite (SQL `LIKE`/comparisons)
  and MongoDB (regex / `$gt`…`$lt`). The button shows a badge with the active
  condition count.

- **Empty a table from the schema explorer (#69).** A new "Empty table" entry
  in a table's (or MongoDB collection's) context menu removes every row while
  keeping the table and its structure — handy for tables used as logs. It uses
  `TRUNCATE` on Postgres/MySQL, `DELETE FROM` on SQLite, and `deleteMany({})`
  on MongoDB. A confirmation dialog guards the action and carries a "don't ask
  again" checkbox backed by a dedicated `confirmEmptyTable` preference, so
  silencing it never weakens other destructive confirmations.

- **MCP connector write-mode, with a per-connection permission model.** The
  headless `huginndb-mcp` connector, read-only since 1.7.0, can now perform
  writes — governed per connection, not by a single global switch. Each
  connection carries a **write policy** set in Settings → MCP:
  - `read-only` (default) — only reads succeed;
  - `data` — adds row-level DML (`INSERT`/`UPDATE`/`DELETE`) via `run_query`
    plus the new `insert_row` / `update_cell` / `delete_rows` tools;
  - `full` — also allows DDL (`CREATE`/`DROP`/`ALTER`/…) via `run_query`.

  The policy is re-read from `profiles.json` on every write attempt, so
  changing a connection's level takes effect without restarting the AI client.
  Because the sidecar is a headless process that can't show a prompt, the
  per-action approval stays with the MCP client, and HuginnDB records every
  write (success or failure) to `mcp-audit.log` alongside your profiles. A
  whole-table `UPDATE`/`DELETE` with no `WHERE` is refused outright, and a new
  `--read-only` flag forces every connection read-only regardless of its saved
  policy. The old `--allow-writes` flag is deprecated and inert. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.8.3] — 2026-07-16

### Added

- **Create a MongoDB collection from the explorer (#61).** MongoDB creates a
  collection implicitly on first write, so there was no way to materialize an
  empty collection from the UI — you had to insert a document first. A "New
  collection" entry now sits in the MongoDB database context menu (and a "+"
  button in the single-database toolbar, mirroring the Postgres/MySQL "New
  database" affordance), issuing an explicit `create` command via a new
  `create_collection` backend command so the collection appears in the tree
  before any document exists, matching MongoDB Compass. The name is validated
  (non-empty, no reserved `system.` prefix); non-Mongo drivers are rejected
  (they create tables through the structure editor).
- **Choose which databases a connection shows, DataGrip-style (#64).** A
  multi-database connection listed *every* database on the server and warmed
  all of them in the background — noisy and slow on servers with dozens of
  databases. A new checklist (the list-checks button in the multi-DB explorer
  header) lets you pick the subset you actually work with; the explorer then
  renders only those and, crucially, scopes the background prefetch to them so
  connecting to a big server no longer fans out across everything. The choice
  persists per connection (`visible_databases` on the profile; `null` = show
  all, so newly-created databases keep appearing automatically). Applies to
  Postgres/MySQL and MongoDB clusters alike.
- **Import and export MongoDB collections as JSON (#65).** The whole-database
  `.sql` export never supported MongoDB. Each collection now has "Export
  collection (JSON)…" / "Import JSON…" in its context menu, using **canonical
  MongoDB Extended JSON** so `ObjectId`/`Date`/`Decimal128`/… round-trip with
  their types intact (unlike the display form the grid shows). Export streams
  straight from the cursor to the file; import accepts a JSON array, a single
  object, or newline-delimited JSON (mongoexport's default) and `insert_many`s
  the batch after a destructive-action confirmation.

### Changed

- **The OS window title now reflects the active connection and table (#57,
  #59).** Every window was titled a static "HuginnDB", making multiple windows
  impossible to tell apart from the taskbar / Alt-Tab. The title now shows
  `<profile> · <database>.<table> — HuginnDB` for the active table tab (falling
  back to `<profile> · <database>` for other tabs, and plain "HuginnDB" when
  nothing is connected), and table tabs themselves are labelled `database.table`
  instead of just the table name, so the database and table are always shown
  together. The redundant `schema › table` breadcrumb that used to sit next to
  the data-grid filter is gone — the tab title already carries that identity.
  Secondary windows are covered by the capability config (`win-*`), which also
  gives them the window permissions they need in general.
- **Connecting to a many-database server is now instant — the explorer no
  longer eagerly caches every database's tables on connect.** The multi-DB
  explorer used to warm the table list of *every* database in the background
  right after connecting, so a connection with 19+ databases sat visibly
  "Caching schema… n/m" for a moment before settling. That eager warm was only
  ever a search optimization, and it is now redundant with the visible-databases
  selector (#64) and the active-database scope: databases load lazily when
  expanded, and the cross-database search still fans out on demand the first
  time you search. Net effect: connect is immediate regardless of how many
  databases the server has; the only trade is that the first cross-database
  search after connecting is served cold.

## [1.8.2] — 2026-07-15

### Added

- **The self-updater now catches up on releases published while the app
  stays open, instead of only checking on launch.** `checkOnLaunch` used to
  be the only trigger — an instance nobody ever closes (a shared machine, a
  workstation that's never rebooted) could sit on the previous version
  indefinitely no matter how many releases were published, since publishing
  was never the missing piece — the app just never asked again. A new
  `startPeriodicChecks` (`src/stores/update.ts`) re-runs the same check every
  4 hours for the lifetime of the running app, so a long-lived instance
  eventually notices on its own. Paired with that: the installer download
  now starts silently in the background the moment an update is detected
  (`startBackgroundDownload`), so by the time anyone actually notices the
  banner, installing is instant instead of waiting on a fresh download. The
  one thing this deliberately does **not** automate is `install()` itself —
  the step that overwrites files, force-kills the `huginndb-mcp` sidecar
  (gotcha #23), and can prompt Windows for elevation — which only ever runs
  off an explicit "Install" / "Restart now" click, never unattended. A new
  `readyToRestart` status distinguishes "downloaded, one click from done"
  from "still fetching" in both the top banner and Settings → About.
  Because installing force-kills the MCP sidecar, `installAndRelaunch` also
  checks whether it's currently running (a new `is_mcp_sidecar_running`
  Tauri command — a `tasklist`/`pgrep` shell-out, no new dependency) and, if
  so, confirms with the user first instead of silently yanking a connection
  an AI client might be mid-use of.
- **Documented Cursor and Antigravity as MCP clients, and improved the
  Settings → MCP connections list.** `huginndb-mcp` is a plain stdio MCP
  server with no client-specific code, so it already worked with any
  spec-compliant client — Cursor and Google's Antigravity IDE included — the
  gap was that `docs/MCP.md` only spelled out Claude Code, Claude Desktop,
  and Codex, leaving users of other agentic IDEs to guess at config file
  locations and JSON shapes. Added dedicated sections for both: Cursor's
  `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global), and
  Antigravity's UI-driven "Manage MCP Servers → View raw config" flow — both
  documented as using the exact same `mcpServers`/`command`/`args` shape the
  app's Settings → MCP panel already generates, so the existing JSON snippet
  pastes in as-is. Separately, the connections list in Settings → MCP now has
  a name filter and a "select all / deselect all" button (scoped to the
  currently filtered rows) plus a live `n of m selected` count — the flat
  checkbox list didn't scale past a handful of saved connections.
- **`docs/MCP.md` now has a maintained Spanish translation
  (`docs/MCP.es.md`).** The in-app Documentation viewer (Help → Documentation)
  bundled the MCP guide in English only, regardless of the user's chosen UI
  language — inconsistent with the rest of the app, which already ships full
  Spanish strings and a Spanish `CHANGELOG.es.md`. `src/lib/docs.ts` now keeps
  a per-language `bodies` map per doc entry (English always present) and
  `getDocBody` falls back to English when a translation is missing, mirroring
  `getReleases` in `lib/changelog.ts` — the same "English authoritative,
  Spanish may lag" contract used for the changelog.

## [1.8.1] — 2026-07-15

### Fixed

- **Updating on Windows while an MCP client had the `huginndb-mcp` sidecar
  running could fail with a spurious permissions error.** The NSIS installer
  stays on Tauri's default `currentUser` install mode (writes under
  `%LOCALAPPDATA%`, no elevation needed), and correctly closes a running
  `huginndb.exe` before overwriting it — but it had no idea `huginndb-mcp.exe`
  exists, since that process is spawned independently by whatever external
  MCP client has it configured (Claude Desktop, Claude Code, ...), never by
  HuginnDB itself. If a client still held it open during an in-app update,
  Windows locked the file and the overwrite failed with
  `ERROR_SHARING_VIOLATION`, surfaced to the user as a generic access-denied
  error even though no admin permissions were actually missing. A new
  `NSIS_HOOK_PREINSTALL` installer hook (`src-tauri/windows/hooks.nsi`) now
  force-closes the sidecar before any files are copied; the MCP client just
  respawns it the next time it needs the connector.
- **`huginndb-mcp` rejected SQLite and password-less MongoDB connections with
  "no stored password for keychain account ...::".** The desktop app's
  `resolve_password` helper already knows SQLite never stores a password
  (there's nothing to authenticate — it's a local file) and that MongoDB's
  is optional (it may be embedded in the connection URI, or the server may
  allow unauthenticated access), falling back to an empty string in both
  cases. The MCP server's `ensure_connected` never reused that helper — it
  called `keychain::require_password` directly, so any SQLite or bare-URI
  MongoDB connection exposed to an MCP client failed every tool call with a
  spurious "missing credential" error, even though nothing was actually
  missing. It now calls the same `resolve_password` the desktop app uses.

## [1.8.0] — 2026-07-14

### Fixed

- **MongoDB Security panel works on multi-database connections.** The 1.7.0 fix
  for #52 taught `list_collections` to return an empty list at the cluster
  level instead of erroring, but `list_users`/`list_privileges` were never
  updated the same way — opening the Security tab on a MongoDB connection with
  no preselected database still threw "no database selected". Both now run
  cluster-wide via the `usersInfo` command with `forAllDBs: true` against the
  `admin` database when no database is selected (the same cluster-level
  pattern the connection health-check ping already used), falling back to the
  existing per-database behavior otherwise.
- **MCP `run_query` no longer rejects every MongoDB query.** The read-only
  guard reused the plain-SQL keyword classifier (`select`/`with`/`show`/
  `explain`/`pragma`), which a mongosh statement like `db.coll.find({...})`
  never matches — so any MongoDB read submitted through `huginndb-mcp`'s
  `run_query` tool was rejected by default, with the only escape hatch being
  the server-wide `--allow-writes` flag (which also unlocks real SQL writes on
  every other exposed connection). The desktop query editor never had this
  problem because it classifies Mongo statements with `MongoOp::is_read()`
  before the generic gate runs; `run_query` now does the same.
- **MCP tools can target a database on a multi-database MongoDB connection.**
  `list_tables`, `describe_table`, `list_indexes`, and `browse_table` accepted
  a `schema` parameter that was silently ignored for MongoDB — every call on a
  database-less connection failed with "no database selected", with no way to
  say which database to use, and `run_query` had no way to target one for a
  bare `db.coll.find()` either. The desktop app solves the equivalent problem
  by opening a synthetic per-database pool when a user expands a database in
  the schema explorer; that logic needed no Tauri `AppHandle`/`Window` to
  begin with, so it's now shared with the MCP server, which resolves the same
  per-database pool whenever `schema` (or `run_query`'s new `database`
  parameter) names a database on a connection with none bound.
- **`browse_table`'s `limit`/`offset` accept a numeric string.** Some MCP
  clients serialize integer arguments as JSON strings despite the advertised
  schema; both fields now parse either a JSON number or a numeric string
  instead of rejecting the call outright.

### Added

- **Real per-column BSON types in MongoDB query/browse results.** `run_query`,
  `browse_table`, and the data grid used to label every column with a generic
  `"bson"` type, even though each field has a concrete BSON type. Columns now
  report the actual type inferred from the returned documents/values (`int`,
  `string`, `date`, `objectId`, …), falling back to `"mixed"` when a field's
  non-null values disagree in type across the result set — an honest answer
  rather than silently picking one. This also gives AI tools using the MCP
  connector a real type signal instead of none.
- **Collection size in the MongoDB explorer.** Collections previously always
  showed an unknown size. A single `$collStats` aggregation run at the
  database level now returns storage stats for every collection in one round
  trip (rather than one `collStats` call per collection), so the explorer can
  show an on-disk size the same way the SQL drivers do.

## [1.7.1] — 2026-07-14

### Added

- **`huginndb-mcp` now ships bundled with the installer, and Settings gained
  an MCP panel.** Previously the connector was reachable only by cloning the
  repo and building it yourself — no packaged install ever included the
  binary. It's now a Tauri sidecar (`bundle.externalBin`), installed
  side-by-side with the main executable, and the release workflow builds and
  stages it automatically. **Settings → MCP** resolves that path, lets you
  pick which saved connections to expose, and generates a ready-to-paste
  `claude mcp add`/JSON snippet — no more hunting through install
  directories or `profiles.json` for connection ids by hand. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.7.0] — 2026-07-14

### Added

- **MCP connector (`huginndb-mcp`).** A headless, read-only [Model Context
  Protocol](https://modelcontextprotocol.io) server that exposes the databases
  HuginnDB already knows about — profiles from `profiles.json`, passwords from
  the OS keychain — to AI coding tools (Claude Code, Claude Desktop, Cursor, …)
  over stdio, so an assistant can inspect real schema and data instead of
  guessing. It is a separate process from the desktop app, opens pools lazily,
  and is **opt-in per profile** (`--connections <id>`): nothing is reachable
  until you name it. Read-only by default (`run_query` rejects non-read-only
  SQL; no write tools), with a `--max-rows` cap (default 1000). Ten tools:
  `list_connections`, `list_databases`, `list_tables`, `describe_table`,
  `list_indexes`, `run_query`, `browse_table`, `server_version`, `list_users`,
  `list_privileges`. Built behind an optional `mcp` cargo feature
  (`cargo build --features mcp --bin huginndb-mcp`), so a normal
  `pnpm tauri:build` is unaffected. See [`docs/MCP.md`](docs/MCP.md).
  
### Fixed

- **Multi-database connections now show a name in the title bar (#51).** The
  centred breadcrumb rendered the connection's catalog directly, so a
  multi-database connection (no single preselected database) left the middle
  segment blank. It now falls back to the connection name when there is no
  single database.
- **The docked side editor no longer keeps a value from another table (#49).**
  Opening a cell in the side editor and then switching to a different tab left
  the old value on screen even though you were looking at an unrelated table.
  The panel is now scoped to the tab that opened the cell: it clears when you
  switch away (unless the buffer has unsaved edits, which are preserved so a
  tab switch never drops your work).
- **The column-resize guideline lands on the real column edge (#46).** The live
  guideline was positioned from TanStack's nominal column widths, but the grid
  uses a `table-fixed`/full-width layout that stretches columns past those
  widths when they don't fill the viewport, so the guideline drifted left of
  the actual edge (the error grew per column). It now measures the resizing
  header's rendered position.
- **MongoDB connections open without a preselected database (#52).** Opening a
  MongoDB connection in multi-database mode failed with a driver error because
  listing collections required a selected database, which blanked the whole
  tree. Listing collections at the cluster level now returns empty (as the SQL
  drivers already do), so the database list renders and you can expand into a
  specific database as before.
- **New windows are independent from the main window (#50).** "New window"
  opened a window that adopted the main window's live connection — it appeared
  connected without the user opening anything, contradicting the per-window
  independence introduced in 1.4.0. The set of open connections is now
  per-window: a window shows a connection as active only when it opens the pool
  itself. Shared configuration (saved profiles and preferences) still syncs
  across windows, and a connection closed in one window is still cleaned up in
  the others that had it open.

### Changed

- **Windows installer switched from MSI (WiX v3) to NSIS.** The release build
  started failing to bundle the `.msi` on GitHub's Windows runners — WiX v3
  has been unmaintained/archived since February 2025, and its `light.exe`
  reliably failed to even launch on the current runner fleet regardless of OS
  image (Windows Server 2022 or 2025), with no error detail beyond a bare
  process-launch failure. Tauri officially supports MSI → NSIS as an update
  path (the reverse is not supported) and the bundled `tauri-cli` here
  (2.11.1) already includes NSIS's detection of a prior MSI install. Existing
  installs auto-update to a `-setup.exe` instead of a `.msi`; the installed
  app itself is unaffected.
- **`huginndb-mcp` moved to its own workspace crate (`src-tauri/mcp-server/`).**
  The NSIS switch above then hit a second, unrelated bundler issue: with more
  than one `[[bin]]` in a package, `tauri-bundler` tries to size/bundle every
  declared binary regardless of feature gating, so it went looking for a
  `huginndb-mcp` build artifact that a normal `pnpm tauri:build` never
  produces. Moving the (already-thin) binary shim to a sibling crate keeps it
  entirely out of the app's own `cargo metadata`. Build it with
  `cargo build -p huginndb-mcp --release` from `src-tauri/` — see
  [`docs/MCP.md`](docs/MCP.md).

## [1.6.1] — 2026-07-10

### Added

- **Searchable, grouped, multi-select connections manager (#39, #43, #40).**
  The manager's left rail was a flat single-select list that got unwieldy past
  a handful of connections. It now:
  - has a **search box** filtering by name, host, database, group, or URI;
  - renders connections as a **folder tree** (grouped by the `group` field)
    with collapsible group headers — an active search force-expands so matches
    are always visible;
  - supports **multi-selection** (Ctrl/Cmd-click to toggle, Shift-click for a
    range, plus per-row checkboxes on hover) with a **bulk delete** that always
    asks for confirmation, regardless of the "confirm destructive actions"
    preference.
- **Duplicate connection (#38).** The connections manager gained a *Duplicate*
  action that clones the selected profile into a fresh draft with a uniquified
  name ("… (copy)"), ready to tweak and save. The password is intentionally not
  carried over — credentials are keyed by profile id in the OS keychain and the
  clone gets a new id — so a banner reminds you to re-enter it before
  connecting.
- **Configurable connection-group expand mode (#40).** A new General preference
  (`Connection groups`) controls how folder groups start out in the File menu
  and the connections manager — *always expanded*, *always collapsed*, or
  *remember per group* (the previous behaviour). The File menu's groups are now
  collapsible too, matching the status-bar switcher.

- **Brand logos in the driver dropdown.** The connection editor's driver
  selector now shows each database's official logo next to its name (both in
  the trigger and the options), reusing the bundled `DriverBadge` marks already
  used elsewhere, instead of a bare list of names.
- **Live guideline while resizing data-grid columns (#42).** Dragging a column
  edge now shows a full-height vertical guideline that tracks the pointer, so
  you can see the target width before releasing instead of eyeballing it
  against the neighbouring column. The width still commits on release (the
  existing deferred, per-table-persisted behaviour).

### Fixed

- **The docked side editor now closes when its source tab closes.** The
  JetBrains-style side editor lives outside any tab's subtree, so opening a
  cell in it and then closing that table's tab left it lingering with a stale
  value, waiting for a manual discard. The cell now records its owning tab and
  the panel closes itself when that tab (or its connection) goes away.
- **Cell editor undo no longer reaches into the previously-edited cell.** The
  docked side editor (and the modal) reused a single Monaco model across cells,
  so after editing one row, selecting the same column on another row and
  pressing Ctrl+Z restored the *previous* row's value. Monaco is now remounted
  with a fresh, empty undo stack on each cell load, so undo stays scoped to the
  current editing session; typing within a cell still undoes normally.
- **Boolean BIT cell picker no longer collapses on open (#44).** Editing an
  existing row's BIT column (with BIT shown as boolean) opened the native
  `<select>` but it snapped shut the instant you clicked an option: the cell's
  `onClick` refocused the scroll container, stealing focus from the dropdown.
  The cell now yields clicks to its own inline editor while one is active.
- **Opening a table no longer runs COUNT + SELECT twice (#41).** Two things
  doubled the initial fetch: the callback depended on `searchColumns` (derived
  from the async-loaded column list, so it changed identity and re-ran the
  effect once columns arrived), and React StrictMode double-invokes effects in
  dev. `searchColumns` is now read through a ref, and the fetch dedupes on the
  wire — a byte-identical request already in flight is skipped — so a table
  open issues exactly one COUNT + SELECT in both dev and production.

## [1.6.0] — 2026-07-08

### Added

- **Legible show/hide toggle on every password field.** WebView2 draws a
  native password-reveal eye that can't be themed and renders near-black —
  effectively invisible on dark surfaces. It's now hidden app-wide and
  replaced by a themed `PasswordInput` toggle (muted → foreground on hover,
  bilingual label). Applied to all secret fields: connection password, SSH
  password / passphrase, the export & import passphrases, the connect-time
  password prompt, and the GitHub token in the feedback dialog.

- **Tab management overhaul.** With many tabs open it was hard to tell what
  you had open or jump to a specific table. Four additions address that:
  - **Open-tabs quick switcher (Ctrl/Cmd+P).** A keyboard-first overlay
    listing *currently open* tabs across every connection, grouped pinned-first
    then by `connection · database`. Search by name, navigate with the arrows,
    Enter jumps (and points the workspace at that tab's connection), and each
    row pins/unpins or closes inline (Delete closes the highlighted one).
    Distinct from the command palette (Ctrl+K), which opens *new* things.
  - **Open-table markers in the schema tree.** Every table that's open in a
    tab now shows a soft brand dot in the tree — not just the active one — so
    you can see at a glance what you already have open while browsing.
  - **Tab-strip switcher button** with a live open-tab count, doubling as the
    overflow affordance when tabs don't all fit.
  - **The active tab is always scrolled into view.** Opening a table when the
    strip was already full left the new (active) tab clipped behind the
    overflow ∨ / switcher / "+" controls — dockview scrolls the active tab in,
    but does so before our custom tab content has laid out, so the new tab was
    left hidden. The active tab now scrolls itself fully into view once its
    content is painted.
  - **Pinning + richer bulk-close.** Tabs can be pinned (⋮ / right-click, or
    from the switcher) so they survive "close others / all / to the right";
    pinned tabs carry a pin marker and group first in the switcher. The tab
    menus gained "Close tabs to the right" and "Close others in this
    connection". Pins persist per connection across restarts.
- **"What's new" presentation after an update.** The first launch after an
  update bumps the app to a release flagged `major` now pops a curated,
  iconified highlights dialog (the punchy counterpart to the exhaustive
  changelog in Settings → About). Content is a hand-authored, bundled
  catalogue in `src/lib/releaseNotes.ts` with bilingual copy in i18n; the
  seen-marker is persisted in `localStorage` (mirroring the update store) so
  it fires exactly once per major release, main-window only. Reachable any
  time from Help → "What's new". When cutting a `major` release, add its entry
  (matching the manifest version exactly) and flag it `major`.
- **Visible Run button in the query editor (UI/UX overhaul, phase 2).** The
  editor's primary action had no button at all — it was Ctrl+Enter and a
  per-statement CodeLens only, with a "Run all" that appeared conditionally. A
  brand-filled Run button now leads the toolbar with a Ctrl/⌘+Enter shortcut
  chip, runs the whole buffer (routing to the batch runner when it holds more
  than one statement), and shows a spinner while executing. Save / history are
  demoted behind a divider.
- **Schema tree redesign (UI/UX overhaul, phase 1).** The left database/table
  tree gained clear hierarchy and orientation. The currently-open table is now
  marked in the tree — a soft brand wash plus a 2px inset brand rail, driven by
  the active tab — so you can always see "where you are". The table name is the
  boldest element on its row (foreground / medium weight) against the muted
  section labels and column rows, column data types are colour-coded (numeric
  amber / boolean green / others muted, reusing the grid's semantic hues), and a
  table's columns load behind a shimmer skeleton instead of an italic
  "loading…" line. Column indentation follows a consistent 12px-per-level
  ladder (schema → section → table) with a continuous depth-guide hairline that
  drops from under each open table's chevron, and table metric badges use
  tabular figures. The single-database "database created" confirmation is now a
  themed toast instead of a native `alert()`.
- **Keyboard navigation in the data grid (UI/UX overhaul, phase 1).** The grid
  was mouse-only, at odds with the app's keyboard-first identity. Cells now
  carry a keyboard-navigable "active cell" marked with an inset `brand` ring:
  arrow keys move it, Home / End jump to the row's first / last column, Enter
  opens the cell editor (inline / FK combobox / modal, same routing as
  double-click) and Escape clears it. Clicking a cell seeds the active cell so
  the keyboard picks up from there, and the active cell scrolls into view as it
  moves (instantly — the indicator never animates, since it tracks every
  keypress).
- **Visible row-selection checkboxes in the data grid (UI/UX overhaul, phase 1).**
  Multi-row selection already worked via Ctrl/Cmd- and Shift-click, but there
  was no visible affordance — the `#` gutter only ever showed the row number, so
  the feature was undiscoverable. The gutter now renders a tri-state select-all
  checkbox in the header (checked / indeterminate / empty over the visible rows)
  and a per-row checkbox that appears on row hover and stays while the row is
  selected. Both are backed by the existing PK-keyed selection set (survives
  sort / filter / refetch) and tinted with the `brand` token; row numbers now
  use `tabular-nums`.
- **Export and import whole databases (#34), marked Beta.** No way to get a database out
  of HuginnDB (or back in) short of scripting it by hand. "Export database…"
  (multi-DB explorer context menu, or a toolbar button on a single-DB
  connection) dumps schema + data to one portable `.sql` file for
  Postgres, MySQL, or SQLite. Postgres/MySQL write in three phases — bare
  `CREATE TABLE`, then all data, then `ALTER TABLE ADD CONSTRAINT` (FK) +
  `CREATE INDEX` — so a whole-database dump never needs a table-dependency
  topological sort and never needs elevated privileges (e.g. Postgres's
  superuser-only `session_replication_role`). SQLite instead dumps its
  catalog verbatim from `sqlite_master` (higher fidelity than reconstructing
  DDL — it keeps `CHECK` constraints etc.) bracketed by
  `PRAGMA foreign_keys=OFF/ON`. "Import .sql…" picks a file and runs it
  through the *existing* query batch runner (the same `splitSql` +
  `execute_batch` path the query editor already uses) instead of a second
  execution path, gated behind the destructive-action confirmation. Labelled
  Beta in the UI — verified by type-checking and `cargo check` only so far,
  not yet exercised end-to-end against a live server on all three drivers.
- **Free-form tab colour, and a selectable accent style (#35).** The tab
  colour picker offered only six fixed swatches; a native colour input now
  sits alongside them for any hex value. Separately, the active-tab / custom
  colour accent was hard-coded to a 2px top cap — a new
  Settings → Grid → "Tab accent style" preference (`cap` / `rail` / `boxed`)
  switches it to a left rail or a raised-surface look instead, and a custom
  tab colour now follows whichever edge the chosen style uses instead of
  always drawing on top.

### Changed

- **Themed tooltips (UI/UX overhaul, phase 3).** Added a `SimpleTooltip`
  convenience wrapper over the themed Tooltip primitive and migrated the app
  chrome off native `title=""` so its tooltips match the app's theme instead of
  the OS default: the header buttons (theme toggle, preferences), every
  status-bar affordance (command palette, query-history, density and theme
  toggles, the connections switcher) and the workspace tabs (label, actions ⋮,
  close, new-query +). Menu/context triggers are wrapped at the trigger so the
  tooltip fires on hover while the menu still opens on click. The one case left
  on native `title=""` — deliberately — is a tooltip that lives *inside* open
  menu content (the connection rows' reconnect/disconnect, the tab colour
  swatches): a Radix tooltip there fights the menu's own hover/portal handling,
  and a native OS tooltip doesn't.
- **Clearer connection status (UI/UX overhaul, phase 3).** A lost connection —
  arguably the most important operational signal — was a 6px red dot plus a
  cryptic red icon. Lost rows in the status-bar connection switcher now get a
  destructive row wash and an explicit labelled "Reconnect" button; the
  live/lost indicator dots are a touch larger, the row action buttons have a
  real hit area, and a failed connect surfaces a toast instead of a native
  `alert()`. Status-bar stats (row count, elapsed time, selection) promote their
  numbers to the foreground with tabular figures.
- **Accessible tab actions + active-tab weight (UI/UX overhaul, phase 3).** The
  workspace tabs' close (×) and actions (⋮) buttons were revealed on hover only,
  leaving them unreachable by keyboard; they now also appear on keyboard focus
  (focus-within / focus-visible). The active tab's label gains medium weight to
  match the brand top-cap + raised surface it already carries.
- **Distinctive dialog shell (UI/UX overhaul, phase 3).** Every dialog rode a
  flat `shadow-lg` with a fade-only entry and a bare low-opacity close glyph.
  `DialogContent` now scales in from centre (zoom, the correct motion for a
  centred modal), rides the shared elevation scale (`shadow-elevation-4`), and
  its close button is a properly padded control with a hover background instead
  of a hit-area-less 70%-opacity X.
- **Shared segmented control + console/structure cleanup (UI/UX overhaul,
  phase 2).** A new `Segmented` primitive (keyboard-navigable radiogroup styled
  as one pill strip with a raised active segment) replaces the hand-rolled
  variants: the feedback dialog's bug/feature toggle (two full buttons) and the
  structure editor's section tabs (plain buttons with no active-tab language).
  The console's log filter now uses the shared `Input` (small size) instead of
  a hand-rolled search box, and its kind checkboxes are tinted with `accent-brand`.
- **CellEditor flagship framing (UI/UX overhaul, phase 2).** The Monaco cell
  editor — the app's "star feature" — looked like a stock dialog. It now has a
  titled header rail: the column name, a `brand`-tinted content-type badge
  (JSON/XML/SQL/TEXT), and char/byte-count pills, with the panel/fullscreen
  controls grouped to the right. Ctrl/⌘+S and Ctrl/⌘+Enter save from inside the
  editor (bound via Monaco so they aren't swallowed) with the shortcut shown in
  the footer, the JSON-validity badge is now a compact chip with the parser
  message in its tooltip instead of dumped inline, and the brittle `mr-8`
  close-button-dodge hack is replaced by reserved header padding.
- **Command palette polish (UI/UX overhaul, phase 2).** The flagship
  keyboard-first surface gained the affordances it was missing: a persistent
  footer legend (↑↓ navigate · ↵ run · esc close), a trailing ↵ on the active
  row, a `brand` left-edge accent + brand-tinted icon on the active row, group
  counts on the section headers, and an iconified empty state. The highlighted
  row now scrolls into view during arrow-key navigation (it could previously
  scroll off-screen), and a failed connect surfaces a toast instead of a native
  `alert()`.
- **Unified table-browser chrome (UI/UX overhaul, phase 1).** A table tab used
  to stack two near-identical toolbars. The top bar's breadcrumb (schema ›
  table) and refresh now fold into the data grid's own toolbar so there's a
  single bar, and paging + row-zoom move to a footer status strip with tabular
  figures. The first load of a table shows a shimmer skeleton (with the
  breadcrumb) instead of a bare "loading…" line, and a refetch dims the stale
  rows behind a spinner rather than looking frozen. The delete-row confirmation
  button now uses the destructive (red) style, matching the drop-table dialog.
- **Data-grid readability polish (UI/UX overhaul, phase 1).** Column headers now
  show a persistent sort glyph that brightens on hover (it was a near-invisible
  30%-opacity icon), and the whole header cell gets a hover background so
  sortability is discoverable; the active-sort indicator is right-aligned and
  tinted with `brand`. Numeric readouts — the row count, pagination range and
  query elapsed time — use tabular figures so they stop shifting width as they
  change, the row/total counts are emphasised in the foreground, and the
  elapsed time turns amber then red only when a query is slow.
- **Tokenised data-semantic accents (`--pk` / `--fk` / `--numeric`).** The
  primary-key / foreign-key key icons and numeric cell values were hard-coded
  as `amber-400` / `sky-400` in the grid and schema tree, ignoring the active
  theme. They're now theme tokens (curated per built-in theme; darker on light
  themes so numerics stay legible on white) applied in DataGrid and
  SchemaExplorer. Kept out of the Appearance colour editor as niche system
  accents.
- **Design-system foundation (UI/UX overhaul, phase 0).** First pass of a
  larger interface redesign toward a modern, dense dev-tool look. No new
  features — this is groundwork the rest of the overhaul builds on:
  - Two new semantic theme tokens, `--success` and `--warning`, distinct from
    `brand` (the app's one "live / do this" accent) and `destructive` (errors).
    Every built-in theme sets its own curated values and both are editable in
    Settings → Appearance like any other colour. This replaces the hard-coded
    `emerald-*` / `amber-*` / `blue-500` / `red-500` literals that were
    scattered across ~12 components and ignored the active theme entirely — so
    custom themes now recolour connection-status, valid/invalid, warning and
    error affordances. `applyTheme` also clears any token a (pre-existing)
    custom theme doesn't define, letting the stylesheet default apply instead
    of leaving a stale inline value from the previously active theme.
  - Unified the "this connection is live" indicator on the `brand` token; it
    previously rendered emerald in the File menu but brand in the status-bar
    switcher for the exact same state.
  - Added an elevation scale (`shadow-elevation-1…4`, keyed off `--foreground`
    so it reads in both light and dark themes) and a tokenised micro-type scale
    (`text-2xs` / `text-3xs`, with a 10px legibility floor) to replace ad-hoc
    `text-[9px/10px/11px]` values.
  - Stronger, consistent keyboard focus ring (`ring-2` + offset) on buttons,
    inputs and selects, replacing the near-invisible 1px flush ring.
  - Form field labels now default to `text-foreground` instead of muted grey,
    giving every dialog real label/value hierarchy.
  - `Input` gained density variants (`inputSize` default/sm/xs) and a new shared
    `Textarea` primitive replaces the hand-rolled multiline fields in the
    feedback and save-query dialogs.
  - Defined a real UI sans-serif font stack (Inter first, falling back to the
    platform UI font) instead of relying on the bare system default.

### Fixed

- **Long table names no longer force horizontal scroll in the schema tree
  (#33).** The table-name label had `truncate` but, as a flex child with no
  `min-w-0`, never actually shrank below its content width (flex items
  default to `min-width: auto`) — so a long name pushed the row-count/size
  badge off and the tree scrolled horizontally instead of ellipsizing.
- **The tab's right-click menu now matches its ⋮ menu (#36).** The two were
  hand-maintained separately and had drifted: right-click was missing
  Split right/down, Float panel, and the colour swatches that the ⋮ menu
  already had. Both now show the same actions in the same order.

## [1.5.1] — 2026-07-07

### Added

- **Drop database from the multi-DB explorer (#19).** The database node's
  context menu gained a destructive "Drop database…" action (Postgres/MySQL
  only), so a database you created can also be removed — previously the node
  only offered "New query here" / "Security" and a created database was stuck.
  A new `validate_ident`-guarded `drop_database` backend command closes the
  synthetic per-database pool (awaiting `Pool::close`) before issuing `DROP
  DATABASE`, so Postgres doesn't reject it for having live sessions; on success
  the UI tears down that database's tabs + schema slice and refreshes the tree.
- **Connection groups shown as folders in the File menu (#20).** The File menu
  listed every connection flat, so a profile's `group` had no visible effect
  there. Connections are now bucketed by group: ungrouped first, then one
  labelled folder per group (sorted) with its connections indented beneath.
- **Themed combobox for the Group field (#21).** The connection editor's Group
  field used a native `<datalist>` whose suggestion popup was drawn by the
  OS/webview and ignored the app theme. It's now a themed, still-creatable
  combobox (typing a new name still creates a new group) that substring-filters
  existing group names in an in-theme popover.
- **Tab colour coding (#24).** Open tabs can be colour-coded from the tab's ⋮
  menu (six preset swatches + clear); the colour shows as a 2px cap on the
  tab's top edge and persists per connection.
- **Refresh button in the structure editor (#25).** The table-structure tab
  gained a refresh button that re-reads the table's current definition from the
  server, so changes made elsewhere while the tab is open can be pulled in.
- **Scroll-to-top / scroll-to-bottom in the console (#29).** Two toolbar
  buttons jump the console log to its first or last entry.
- **Active connection marked in the status dropdown (#31).** The connection the
  workspace is focused on now gets a brand wash + "active" tag in the status-bar
  dropdown, distinct from the other merely-connected rows.

### Fixed

- **Connection errors no longer clip at the dialog edge.** A failed Test /
  Connect rendered its (often long) backend message on a single `truncate`d
  line in the connection dialog footer, so anything past the dialog width was
  cut off with an ellipsis and unreadable — most database driver errors are far
  wider than the footer. Error and save-error states now get a bounded,
  wrapping, vertically-scrollable box (destructive-tinted, with an alert icon)
  and a one-click copy button for the full message; the short states (testing /
  success / saved) stay on their single line.
- **Same table on two connections/databases no longer renders identical tabs
  (#22).** Tab labels only carried a connection prefix when more than one
  distinct connection had tabs open, and the prefix omitted the database, so
  the same table opened on two connections (or two same-named databases) showed
  as an indistinguishable bare name. Labels now include `connection · database`
  context and escalate to it whenever another open tab shares the bare title.
- **A CLI second-launch no longer spawns a third window (#23).** With "always
  open in a new window" set, launching again from the CLI while an instance was
  running produced three windows. The second-launch routing ran in every
  window, so the window spawned to satisfy the "new window" route re-drained the
  shared pending-intent buffer and routed it a second time. Routing is now
  gated to the main window only.
- **Empty tables show their columns and the insert affordance (#27).** A table
  with no rows rendered no column headers and no way to add the first row,
  because the result decoders derive columns from the first row. `fetch_table_data`
  now falls back to the catalog definition when a page comes back empty.
- **DDL apply failures are surfaced (#26).** A structure change the database
  rejects — e.g. a primary key exceeding MySQL's max key length — only showed a
  message in the small DDL-preview pane and read as a silent no-op. It now also
  raises a toast.
- **The port field can be cleared (#28).** Emptying a numeric port field snapped
  back to a stuck `0` that couldn't be backspaced away. Falsy `0` now renders as
  an empty field, restoring normal clear/retype (all four port inputs).
- **No text highlighting on Shift+Click row selection (#30).** Range-selecting
  rows also dragged a native text selection across their contents; the grid is
  now `select-none`.
- **Connection dropdown consistency (#31).** The File-menu dropdown now shows
  connection groups (see the grouping change above) and the status-bar dropdown
  marks the active connection, resolving both halves of the report.

## [1.5.0] — 2026-07-04

### Added

- **Create database.** Both the multi-DB explorer toolbar and the
  single-database root header gained a "+" button (Postgres/MySQL only —
  server-level DDL, hidden for SQLite/MongoDB) that opens a name dialog and
  issues `CREATE DATABASE` via a new `create_database` backend command,
  validated through the same `validate_ident` allowlist the structure
  editor uses. The multi-DB toolbar refreshes its database list on success;
  a single-DB connection has no such list to show the change, so it
  confirms with a message instead (a profile scoped to one database is at
  least as common as multi-DB browsing — there's no reason it should be the
  one mode that can't create a sibling database on the same server).
- **Resizable data-grid columns.** `DataGrid.tsx` now wires up TanStack
  Table's column-resizing API (drag handles on column borders,
  `columnResizeMode: "onEnd"` so a drag doesn't spam re-renders). Widths are
  persisted per browsed table (`prefs.json`'s new `grid.columnWidths`,
  keyed by `"<schema>.<table>"` then column name) — ad-hoc query result
  grids resize in-session only, matching how they don't have a stable table
  identity to key against.

- **Connection grouping.** `ConnectionProfile` gained a free-text `group`
  field (single group per connection, no separate group registry — grouped
  by simple string equality), editable from a new "Group" field in the
  connection dialog (with a datalist of existing group names as a
  duplicate-avoidance nudge). The status-bar connections dropdown
  (`StatusConnections.tsx`) — the app's actual live connection
  switcher — now buckets both the Active and Available sections into
  collapsible per-group headers, with ungrouped connections staying flat at
  the top exactly as before. Collapse state persists per group name in
  `prefs.json` (`ui.collapsedConnectionGroups`). New `bucketByGroup` helper
  in `src/lib/utils.ts`.

### Fixed

- **Connecting the same profile from a second window tore down the first
  window's live pool.** `ActiveConnections::insert` unconditionally replaces
  whatever pool is already registered for an id — correct for reconnecting
  a dead pool, wrong for a second window's `connect` call racing an
  already-active profile, which silently dropped the first window's pool
  (and any SSH tunnel) out from under it. `connect` now checks
  `ActiveConnections::contains` first and no-ops (reusing the existing
  pool) instead of falling through to the replace path.
- **No window learned about another window's connections, profile edits, or
  preference changes.** Every Tauri window shares one backend `AppState`,
  but each window's frontend held a private snapshot of `active`/`profiles`/
  `prefs` taken once at boot with no bridge back out — worse than staleness
  for preferences specifically, since every save sends the *entire* blob
  (not a diff): two windows changing different settings would silently lose
  whichever saved first the moment the other's debounced write landed.
  `connect`/`disconnect`/`save_profile`/`delete_profile`/`import_profiles`/
  `update_preferences` now broadcast `connection-opened`/`-closed`/
  `profiles-changed`/`prefs-changed` events; new frontend bridges
  (`connection-sync-bridge.ts`, `prefs-sync-bridge.ts`) apply them to every
  window's stores — `markConnected`/`markDisconnected` in
  `stores/connections.ts` (factored out of `connect()`/`disconnect()` so
  the sync path and the local path share the exact same cleanup, including
  the multi-DB synthetic-child tab/schema sweep) and `applyExternal` in
  `stores/preferences.ts` (adopts the broadcasted snapshot without
  re-triggering a save, so it can't loop or re-race).
- **MySQL `insert_row`/`update_cell` could bind a `BIT` column as plain text
  when the frontend's schema-cache metadata hadn't loaded yet.** Both
  commands decide whether to wrap a MySQL `BIT` column's placeholder in
  `CAST(? AS UNSIGNED)` based on a `column_type` hint the frontend sends
  alongside the value; when that hint is `None` (schema cache empty/stale
  for the target table), the value was bound as a plain string, which
  MySQL rejects with `1406 (22001): Data too long for column` for anything
  wider than one character (e.g. `"true"`). Both commands now fall back to
  a catalog lookup (`list_columns_inner`, the same helper `fetch_fk_options`
  already uses) when the hint is missing, so a `BIT` column is detected
  correctly either way. `insert_row` only pays for the extra round-trip
  when at least one value actually lacks a type hint.
- **Console/connection-lifecycle log entries leaked across windows.** Every
  Tauri window (the main window, or any secondary "New window") mounted the
  same frontend and independently subscribed to the same backend log event,
  which was broadcast process-wide (`AppHandle::emit`) rather than targeted —
  so a query run in one window showed up in every other open window's
  Console panel too, making a secondary window look like a pointless copy
  of the main one instead of an independent instance. `log_bus::emit` now
  takes the originating window's label and delivers only to it
  (`AppHandle::emit_to`); every command that produces a SQL or
  connection-lifecycle log entry (`execute_query`, `execute_batch`,
  `fetch_table_data`, `update_cell`, `delete_rows`, `insert_row`, `connect`,
  `disconnect`, `test_connection`, `open_database_view`) now takes a
  `tauri::Window` parameter (auto-injected by Tauri from the invoking
  webview — no frontend change needed) to supply it. The keepalive
  background task's own diagnostic log entry has no single originating
  window (it reports on a connection every window may be browsing), so it
  keeps broadcasting via a new `log_bus::broadcast`; the separate
  `connection-lost` event it emits for the reconnect UX was already correct
  as a broadcast and is unchanged.

## [1.4.0] — 2026-07-02

### Added

- **Server-side users/permissions ("Security" panel).** A new `Security`
  action next to the schema explorer's refresh button (and, per database, in
  the multi-DB explorer's context menu) opens a tab listing the users/roles
  the current connection can see, with lazy-loaded privileges on row expand.
  Implemented for every driver rather than a subset: **PostgreSQL**
  (`pg_roles` + `pg_auth_members` for role membership, table grants via
  `information_schema.role_table_grants`), **MySQL** (`mysql.user` +
  `mysql.role_edges` for MySQL 8 roles, privileges parsed out of
  `SHOW GRANTS FOR '<user>'@'<host>'` since MySQL has no privilege catalog
  view equivalent to Postgres'), **MongoDB** (`usersInfo` per the resolved
  database, privileges via `usersInfo` with `showPrivileges: true`), and
  **SQLite**, which has no user/permission concept at all and now renders an
  explicit "this driver has no server-side user model" empty state instead
  of silently omitting the feature. A MySQL account without `SELECT` on
  `mysql.user` degrades to reporting just itself (`CURRENT_USER()`) instead
  of failing the whole panel. New backend commands `list_users` /
  `list_privileges` in `src-tauri/src/commands/schema.rs` (dispatched to
  `src-tauri/src/db/mongo/schema.rs` for MongoDB); new `UserInfo` /
  `PrivilegeInfo` DTOs mirrored in `src/types.ts`; new frontend
  `SecurityTab.tsx` (TanStack Table) and `security` tab kind.
- **Connection keepalive + lost-connection reconnect.** HuginnDB previously
  did nothing proactive to keep a connection alive — no idle timeout, no
  heartbeat — relying entirely on `sqlx`'s default "validate on next use"
  behaviour, which doesn't help an idle pool between user actions or a
  dropped SSH tunnel. Every top-level connection now gets a background ping
  every 3 minutes; a failed ping flags the connection as lost, which turns
  its status dot red in both the connection list and the status-bar
  connections dropdown and swaps the connect/disconnect button for a
  one-click "reconnect" — no more discovering a dead connection mid-query
  with only a cryptic driver error. Reconnecting reuses the same connection
  id and keeps open tabs and schema-tree state intact rather than closing
  everything and starting over. Scoped to top-level profile connections
  only; the synthetic per-database pools used by multi-DB browsing share
  their parent's liveness and don't get a separate heartbeat. New backend
  module `src-tauri/src/keepalive.rs`; new frontend
  `stores/connectionHealth.ts` + `lib/connection-health-bridge.ts`.
- **F5 / Ctrl+R (Cmd+R on macOS) now refresh in-app instead of reloading the
  WebView like a browser tab.** With a table tab active, it re-runs that
  tab's own query (same as clicking its reload button, respecting the
  current filters/sort/page); otherwise it refreshes the schema tree
  (database + table list) for the selected connection — matching the
  explorer's own refresh button in both single-DB and multi-DB mode. New
  `src/lib/tableRefresh.ts` registry (same "populate on mount, clear on
  unmount" shape as the Monaco SQL provider registry) lets the global
  key handler in `App.tsx` reach the active table tab's reload function
  without threading a callback through the dockview panel tree.

### Changed

- **Workspaces replaced by native windows.** Workspaces were only ever a
  stand-in for real per-window instances, and the "new workspace vs current"
  dialog shown on a second `huginndb …` launch never worked correctly. The
  workspace switcher is gone; **Window → New window** opens a real, blank OS
  window instead. Secondary windows are intentionally ephemeral — nothing
  about their tabs or layout survives an app restart, only the main
  window's does. The on-disk `tab_state.json` moves to v3 (a flat
  `connections` map); on upgrade, a v2 blob keeps only the previously
  **active** workspace's tabs and discards every other workspace — there is
  no merge. The second-launch dialog still asks "this window or a new one?"
  by default, but now offers a "don't ask again" toggle that remembers the
  choice (`Preferences → cliConnectDefault`).
- **Top bar menus split from 2 to 4.** File and View had accumulated
  unrelated actions as the app grew. File now holds only connection
  management (new/manage/import/export, the connection list, disconnect
  all); a new **Window** menu takes New window and Reset window layout; a
  new **Help** menu takes Report/suggest and About (previously File-only
  and gear-icon-only, respectively). View is unchanged (panel visibility +
  schema-tree metric).

### Fixed

- **A new window created via "Window → New window" rendered blank and
  Windows flagged it as "Not Responding".** `WebviewWindowBuilder::build()`
  deadlocks on Windows when called from a synchronous Tauri command — a
  documented WebView2 issue. `open_new_window` is now an `async fn`, which
  Tauri docs call out as the fix.
- **A CLI ad-hoc connection (`--host …`) without `--password` never
  actually connected**, even when chosen via the second-launch dialog's
  "this window" option — it silently created a disconnected profile and
  only logged a hint to the Console. The connect is now always attempted
  (SQLite has no password concept at all, and some servers allow
  passwordless/trust auth); a genuine auth failure still surfaces the same
  way a saved-profile connect failure does.

## [1.3.0] — 2026-07-01

### Added

- **"I don't have a GitHub account" fallback in the issue reporter.** Both
  existing paths (API creation with a stored PAT, or the pre-filled
  `issues/new` browser page without one) still land on GitHub, which is a
  dead end for a user with no account — the browser page just shows a login
  wall. A new link in the dialog's footer builds a `mailto:` URL instead
  (same title/kind-prefixed subject and body, diagnostics block included when
  toggled on) and opens it via the `opener` plugin, handing delivery to the
  user's own default mail app — HuginnDB never touches SMTP or holds a
  mail-sending credential. Percent-encoding is hand-rolled (RFC 3986
  unreserved set) rather than reusing `url`'s `query_pairs_mut`, which is
  `application/x-www-form-urlencoded` and would turn spaces into literal `+`
  characters in the body — technically invalid in a `mailto:` query and
  rendered as-is by several mail clients. The recipient is the project's
  `contact@shion.es` address, kept separate from the mailto path's GitHub
  siblings so a stray report can't be mistaken for a security disclosure.
  Requires widening the `opener:allow-open-url` capability, previously scoped
  to `github.com` only, to also allow `mailto:*`.

- **"Go to referenced row" on foreign-key cells (IDE-style).** In the data
  browser, **Ctrl/Cmd+click** on a cell whose column is a single-column foreign
  key now jumps straight to the referenced master record — opening (or focusing)
  the parent table pre-filtered to that value, the way "go to definition" works
  in an editor. The same action is available from the cell's right-click menu
  ("Go to referenced row"), and FK-navigable cells gain a subtle hover
  underline. Reuses the FK metadata already returned by `list_columns`
  (`referenced_schema` / `referenced_table` / `referenced_column`) — no new
  backend query. The target table receives the filter through a new transient
  `initialFilters` on the tab; re-navigating into an already-open table
  re-applies it instead of silently doing nothing.
- **"New query here" on a database (multi-DB explorer).** Right-clicking a
  database node in the multi-database explorer now offers _New query here_,
  opening a query tab already scoped to that database. It runs against the same
  synthetic per-database connection the explorer uses, so the query targets the
  database you clicked without first having to expand it or switch the active
  scope.

### Fixed

- **The in-app issue reporter now actually opens the browser.** Filing a report
  (or following the "view issue" link) relied on `window.open`, which is a no-op
  inside the Tauri WebView — clicking did nothing. URL opening now goes through
  the `tauri-plugin-opener` plugin and lands in the OS default browser. The new
  capability is scoped to `github.com`, the only host the reporter ever links
  to. Adds the `tauri-plugin-opener` dependency.
- **Hand-typed `INSERT`/`UPDATE` with `BIT`/integer values no longer errors on
  MySQL.** Ad-hoc statements from the SQL editor were sent over the prepared
  (binary) protocol, which rejects or mishandles a family of statements a CLI
  client runs without complaint — the recurring `BIT` / integer-literal errors.
  The editor binds no parameters, so there is nothing to prepare: non-`SELECT`
  statements now run through the **unprepared** simple-query protocol
  (`sqlx::raw_sql`) in both the single-statement and batch paths, so what you
  type is parsed exactly as the server's own client would. `SELECT` decoding is
  unchanged.

## [1.2.0] — 2026-06-18

### Added

- **Single-window consolidation (single instance).** Launching `huginndb` again
  while a window is already open no longer spawns a second window. The running
  window is focused, and — if the new launch carries a connection
  (`--connect-profile`, `--host …`, `--uri …`) — a dialog asks whether to open
  it in a **new workspace** or the **current** one. This makes the workspace the
  real top-level container: keep, say, a MySQL "config" connection and a MongoDB
  "data" connection side by side in one window instead of two detached IDE-like
  instances. A relaunch with no connection flags simply brings the window to the
  front. Implemented with `tauri-plugin-single-instance`; the second launch's
  argv is parsed by the same code path as cold start and forwarded over a new
  `huginndb://cli-connect` event (buffered backend-side to survive a launch that
  races the window's boot).
- **In-app issue reporter.** A new _Report / suggest_ entry (File menu, and a
  "Report this error" action on failed Console entries) opens a dialog to file
  a **bug** or a **feature request** straight to the GitHub tracker. With a
  GitHub Personal Access Token configured (stored in the OS keychain, never on
  disk) the issue is created directly via the REST API and linked back; without
  one, a pre-filled `issues/new` page opens in the browser for manual
  submission. Reports can optionally bundle diagnostics (app version, OS/arch),
  and the "Report this error" path pre-fills the driver, statement, and error
  text. Adds a `reqwest` (rustls) dependency for the API path.
- **Multi-column sort in the data grid.** A plain click on a column header
  sorts by it (cycling ASC → DESC → unsorted); **Ctrl/Cmd+click** adds the
  column as an additional, lower-precedence sort level (cycling
  ASC → DESC → removed in place). Headers now show a direction arrow (↑/↓)
  instead of only highlighting, plus a small level number when more than one
  column participates, so the active ordering is readable at a glance rather
  than only inferable from the console. The `fetch_table_data` command now
  takes an ordered `order` list (replacing the single `orderBy`/`orderDesc`
  pair) and builds `ORDER BY c1 …, c2 …` across all four drivers (the MongoDB
  path uses a multi-key sort document).
- **Primary/foreign-key icons on data columns.** The data-grid column headers
  now show a key icon — amber for a primary-key column, sky-blue for a
  single-column foreign key — and the schema explorer gains the foreign-key
  key next to the existing primary-key one. Mirrors HeidiSQL's at-a-glance key
  indicators; uses metadata already returned by `list_columns`, no extra
  queries.

### Performance

- **Skip the redundant `COUNT(*)` when only sorting or paging.** The data
  browser previously re-ran `SELECT COUNT(*)` on every fetch, including pure
  sort/offset/page changes where the total can't have changed. The frontend
  now caches the total and recomputes it only when the filter/search predicate
  changes (new `with_count` flag on `fetch_table_data`), removing one
  round trip per sort/page interaction — most noticeable on large tables. The
  MongoDB browse path skips `count_documents` the same way. (Sorting on a
  non-indexed column is still a server-side full sort; that's governed by the
  table's indexes, not the client.)

### Changed

- **Simpler "Drop table" confirmation.** Dropping a table no longer requires
  typing the table name to confirm — it now shows a plain destructive
  confirmation dialog (with an irreversibility warning) and a Cancel / Drop
  choice, matching what users expect from other database managers. The action
  is still gated behind an explicit confirmation; only the type-the-name
  friction was removed.

## [1.1.1] — 2026-06-15

### Added

- **MongoDB connection form (field-driven).** The MongoDB connection dialog is
  now form-primary, like Mongo Compass: discrete fields (host, port, database,
  username, password, **auth source**) build the `mongodb://` connection string
  live, shown read-only below them. A new **Edit connection string** toggle
  reveals the raw URI for hand editing — with an amber warning that manual edits
  can introduce errors — for cases the form doesn't cover (Atlas
  `mongodb+srv://`, replica sets, extra URI options). The password is never
  embedded in the stored string: it continues through the OS keychain. Editing a
  saved profile re-populates the form when its URI is representable, and opens in
  raw-edit mode otherwise.
- **`authSource` for MongoDB.** A dedicated _Auth source_ field (e.g. `admin`)
  is appended to the connection string as `?authSource=…`, and a new CLI
  `--auth-source` flag covers the URI-less ad-hoc path
  (`--host … --auth-source admin`). Previously the only way to set it was to
  hand-write the whole URI, and the discrete-field path omitted it entirely —
  so URI-less MongoDB logins that needed a non-default auth database failed.
- **Multi-table filter in the schema explorer (HeidiSQL-style).** The table
  filter now accepts several `;`-separated patterns and matches a table when it
  contains **any** of them, so `users; orders` surfaces both at once. Works in
  both single- and multi-database explorers.

### Fixed

- **The Console detail pane can be closed without clearing the console.**
  Clicking a log entry opened its detail view with no way back to the full list
  short of emptying the console; a **close** button (and the `Esc` key) now
  dismiss the detail and return to the entry list.

## [1.1.0]

### Added

- **MongoDB driver (MVP).** HuginnDB now connects to MongoDB alongside the SQL
  engines. Connect with a connection string (`mongodb://…` or Atlas
  `mongodb+srv://…`, the primary input — it covers replica sets, `authSource`
  and URI options), browse databases → collections in the explorer, and inspect
  documents in the data grid (top-level fields become columns, `_id` first;
  nested documents/arrays render as JSON and expand in the cell preview).
  - **`mongosh`-style query editor.** Run `db.coll.find({…})`,
    `.aggregate([…])`, `.countDocuments(…)`, `.distinct(…)`, and the write
    methods (`insertOne`/`insertMany`, `updateOne`/`updateMany`, `replaceOne`,
    `deleteOne`/`deleteMany`), with chained `.sort()/.limit()/.skip()/.projection()`
    on `find`. Relaxed JSON (unquoted keys, single quotes) and the common BSON
    constructors (`ObjectId(...)`, `ISODate(...)`, `NumberLong/Int/Decimal(...)`)
    are supported.
  - **Edit by `_id`.** Inline cell edits, row inserts and deletes map to
    `updateOne`/`insertOne`/`deleteMany` keyed on `_id`. The field's inferred
    BSON type drives value coercion so a `Date`/`Long`/`Int` field is not
    silently degraded to a string.
  - **Read-only structure.** The structure view shows a collection's inferred
    fields and real indexes; collection drop is supported from the explorer.
    Index/validator editing, transactions, and profile transfer for MongoDB are
    deferred — see `docs/MONGODB_ROADMAP.md`.
  - **SSH tunnelling** is available for single-host `mongodb://` connections;
    it is disabled for `mongodb+srv://` (an SRV record resolves to several
    hosts, which the single-port tunnel can't represent).
  - **CLI:** `--driver mongodb` works with the discrete `--host`/`--port`
    flags, and a new `--uri` / `--connection-string` flag accepts a full
    `mongodb://` or `mongodb+srv://` URI (the only way to reach Atlas from the
    CLI). A connection string implies the MongoDB driver when `--driver` is
    omitted, and MongoDB is now offered in the ad-hoc driver picker.
- **Bulk-close tabs from the tab menu.** Right-clicking a workspace tab (or the
  tab's `⋮` menu) now offers **Close other tabs** and **Close all tabs** in
  addition to **Close tab**, so a workspace full of open tables/queries can be
  cleared in one action instead of closing each tab individually.

### Fixed

- **Filtering the schema explorer no longer crashes on connections without table
  stats.** `list_tables` serialized absent row-count / size statistics as JSON
  `null`; the explorer's metric badge guarded only against `undefined`, so a
  `null` reached `formatBytes` and threw _"Cannot read properties of null
  (reading 'toFixed')"_ — taking down the whole panel. This bit CLI/ad-hoc
  connections and SQLite builds without `dbstat`, and surfaced on filter because
  the filter force-expands every section (rendering badges that were previously
  collapsed). The backend now omits absent stats (matching the `?: number`
  frontend contract) and the badge guards `!= null`; `formatBytes`/`formatCount`
  additionally bail on non-finite input.
- **Opening or closing the side cell-editor no longer resets the Schema /
  Workspace split.** The side-editor docks as a sibling in the
  `[Schema | Workspace | Cell]` row, and dockview redistributes freed/taken
  space proportionally across _all_ siblings when a child is added or removed —
  silently resizing the Schema panel each time. The Schema width is now
  remembered while the side-editor is absent and re-asserted on every
  open/close, so only the Workspace panel absorbs the change.
- **Duplicating a MySQL row with a `BIT` column then saving could fail with
  "Data too long for column".** The 0/1 control showed the normalized value but
  left the draft cell holding the raw duplicated value; if that value wasn't
  already exactly `"0"`/`"1"` (e.g. a duplicated `"true"`, or a legacy `BIT(1)`
  cell carrying a wider/garbage integer), the raw value was what got committed,
  and `CAST(? AS UNSIGNED)` into `BIT(1)` then overflowed. The control now syncs
  the committed cell to the displayed `0`/`1` on mount.

## [1.0.10] — 2026-06-11

### Added

- **Run a whole buffer of statements at once.** Pressing `Ctrl+Enter` (or the
  new "Run all (N)" button) on an editor holding several `;`-delimited
  statements — e.g. a batch of INSERTs copied from the grid — now runs them in
  order on a single connection and shows a per-statement summary, with the last
  SELECT's rows in the grid. Previously the whole buffer was sent as one
  prepared statement, which the driver rejected ("cannot insert multiple
  commands into a prepared statement"). Running them on one connection also
  means an explicit `BEGIN`/`COMMIT` (or MySQL `USE`) now carries across the
  batch. The per-statement "▶ Run" CodeLens still runs a single statement.
- **Database selector in the query editor.** On a multi-database server
  (Postgres / MySQL) the query tab now has a database dropdown: pick a database
  and the query runs against it — and the autocomplete switches to its tables —
  without typing `USE`/a schema prefix into the SQL. Backed by the existing
  per-database child pools. SQLite (single file) shows no selector.
- **Theme and editor previews in Preferences.** Appearance shows a small mock of
  the app chrome plus colour swatches painted with the selected theme; Editor
  shows a sample SQL snippet rendered with the chosen font, size, wrap and
  Monaco theme colours.
- **Fullscreen toggle in the side cell editor**, matching the modal editor
  (`F11` / `Esc`, or the header button).
- **Dedicated 0/1 control for `BIT` columns** in the insert draft row and inline
  cell editing (MySQL). It emits the numeric value the column expects and labels
  the options per the grid's BIT-display preference, instead of a text field
  that looked like it wanted a boolean.

### Changed

- **Connections opened from the CLI are now temporary.** An ad-hoc connection
  launched with `--host …` is kept in memory for the session (so the explorer
  and tabs work normally, marked "temp") but is no longer written to
  `profiles.json`, so it doesn't pile up across launches. Profiles created in
  the app still persist as before.
- **Driver badge tiles are theme-aware** — the brand logos keep their colours
  but the tile/ring now track the active theme instead of a hardcoded white
  square that clashed with dark themes.

### Fixed

- **A large `LONGTEXT` (e.g. a big JSON document) in MySQL rendered as a hex
  dump.** When the server flags a text column as binary (charset/collation
  dependent), sqlx reports it as `LONGBLOB` and `try_get::<String>` rejected it
  on a type-compatibility check _before_ looking at the bytes, so the value fell
  through to hex regardless of content. We now read the raw bytes and validate
  UTF-8 ourselves, so valid-UTF-8 text decodes as text.

## [1.0.9] — 2026-06-09

### Fixed

- **Opening a specific database failed with "no stored password for keychain
  account" when the password came from the CLI.** Expanding a database in the
  tree spins up a child pool (`open_database_view`) that re-resolved the
  credentials from the OS keychain — but a password passed via `--password`
  (or the connect dialog) lives only in memory and was never stored there. The
  backend now keeps a session-only, in-memory cache of the secret used at
  connect time (keyed by profile, cleared on disconnect); child pools reuse it
  and only fall back to the keychain when nothing was cached.

## [1.0.8] — 2026-06-09

### Added

- **Configurable default database driver** (Settings → General). Used when a
  connection is created without an explicit driver: a CLI launch without
  `--driver`, and the initial driver of the "New connection" form. It defaults
  to **"Ask each time"** — so a CLI ad-hoc launch (`--host …`) with no `--driver`
  and no configured default now pops a driver picker (and nudges you to set a
  default) instead of silently assuming PostgreSQL and mismatching a MySQL
  server.

### Changed

- **`--driver` now accepts aliases and is case-insensitive** (`MySQL`, `MYSQL`,
  `mariadb` → mysql; `postgresql`, `pg`, `psql` → postgres; `sqlite3` → sqlite).
  An unrecognized value no longer silently falls back to PostgreSQL — it routes
  to the driver picker.
- **Connection failures caused by a mismatched driver now explain themselves.**
  When a wire-protocol error indicates the wrong backend (e.g. the Postgres
  driver reading a MySQL handshake — "Postgres protocol error … unknown
  transaction status"), the error message now suggests switching the driver,
  in the Console and in the connect dialogs.

## [1.0.7] — 2026-06-08

### Fixed

- **Connections with SSL off failed during the TLS negotiation** ("unexpected
  response from SSLRequest"). With the SSL box unchecked the connection URL
  carried no `sslmode`, so sqlx fell back to its `prefer`/`PREFERRED` default —
  which still sends a Postgres `SSLRequest` (or negotiates MySQL TLS) and chokes
  against servers or poolers that don't speak it. The SSL toggle is now
  explicit: off → `sslmode=disable` / `ssl-mode=DISABLED` (straight to a
  plaintext startup, no negotiation), on → `require` / `REQUIRED`. A server that
  genuinely requires TLS now fails with a clear "enable SSL" error instead of a
  cryptic handshake byte.

## [1.0.6] — 2026-06-08

### Fixed

- **CLI `--flag=value` syntax was ignored.** The startup-arg parser only
  accepted the space-separated form (`--password secret`); the equals form
  (`--password=secret`) didn't match the flag and the value was silently
  dropped — so an ad-hoc launch like
  `huginndb.exe --host … --password=…` created the profile but reported "no
  --password given". The parser now accepts both forms for every flag
  (splitting on the first `=` so values containing `=` survive), with unit
  tests covering both spellings.

## [1.0.5] — 2026-06-08

### Changed

- **The connection dialog is now a master/detail manager** (same layout as the
  preferences dialog): a left rail lists every saved connection with a live
  "connected" dot and a "New connection" entry, and the right pane edits the
  selected profile via the General / SSH-tunnel tabs. The footer carries Test,
  Connect (save + open the pool), Delete (honoring `confirmDestructive`) and
  Save. Opening from the sidebar's `+`/edit still works; connecting from the
  manager focuses the connection in the main view. Import/export profiles live
  in the manager header, and File → "Manage connections" now opens this manager
  (focused on the current connection) instead of the old list-wrapper modal,
  which has been removed.

### Added

- **Official database logos replace the driver initials.** Connection lists,
  the file menu, the status-bar dropdown and the connection manager now show the
  PostgreSQL / MySQL / SQLite brand marks (bundled locally, no CDN) on a light
  tile so the darker logos stay legible on both themes.
- **The app logo now tops the empty-workspace welcome screen**, above the
  "huginndb — select or create a connection" hint.
- **The active connection is now visible at a glance.** The status-bar
  connections control shows the current connection's name and logo (instead of a
  bare count), and both that dropdown and the File menu mark the connection in
  focus with a check.
- **Cell preview panel can be turned off.** A new `grid.cellPreview` preference
  (Settings → Data grid) controls whether the floating value-preview panel
  appears when a cell is selected. With it off, single-click stays pure
  navigation; the heavyweight editor remains reachable via double-click and the
  context menu. Defaults to on (the historical behaviour).
- **`grid.truncateLongTextAt` is now exposed in Settings** and actually applied:
  the grid caps a cell's rendered text at the configured number of characters
  (0 disables) so a multi-MB value can't bloat the DOM. The full value is still
  available in the preview/editor.

### Fixed

- **Several preferences were silent no-ops.** Audited every toggle and wired up
  the ones that weren't being honored:
  - `grid.nullDisplay` — the configured NULL string now renders in both the data
    grid and the cell-preview panel (previously hard-coded `NULL`).
  - `grid.zebraStripes` — alternating row backgrounds are applied (was ignored).
  - `grid.stickyHeader` — the column header only pins when enabled (was always
    sticky).
  - `grid.defaultPageSize` — new table tabs open at the configured page size
    (was hard-coded to 100); the page-size dropdown includes custom values.
  - `ui.queryHistoryLimit` — the query-history ring buffer honors the configured
    size (was hard-coded to 50).
  - `ui.confirmDestructive` — turning it off now actually skips the delete
    confirmations (delete connection, delete saved query, delete rows); the
    type-the-name `DROP TABLE` guard intentionally stays regardless.
- **Ctrl+S in the docked side editor didn't clear the unsaved-changes guard.**
  When a cell was selected with the side panel open, the floating cell-preview
  panel was the one catching Ctrl+S and persisting _its_ stale (pre-edit) value,
  so the side panel's edits weren't saved and its dirty baseline never reset —
  moving to another cell then popped the discard-changes dialog. The side panel
  now owns Ctrl+S (capture phase, taking precedence over the preview): it saves
  its own buffer in place, resets the baseline, and keeps the panel open so you
  can move on without the prompt.
- **The Console detail editor ignored the editor preferences.** It now follows
  the configured Monaco theme, font family and font size instead of the app
  light/dark mode and a fixed font.
- **CLI auto-connect did nothing for ad-hoc launches and failed silently.** The
  startup-arg handler was gated on having at least one saved profile, so
  `--host/--port/--database/--driver/--user/--password` launches were skipped
  entirely on a profile-less machine; it also swallowed every error, so a
  mistyped profile name or a failed connect produced no feedback. The handler
  now runs once on boot regardless of the profile list, awaits a profile
  refresh before matching `--connect-profile` by name/id, and reports failures
  (profile not found, connect error, ad-hoc setup) in the Console panel. The
  backend additionally echoes the parsed flags to stderr on launch (password
  redacted) so a terminal launch can confirm the args arrived.
- **SSH tunnel didn't fall back when the pinned local port was held with
  exclusive access.** The bind-collision fallback only recognised `AddrInUse`;
  on Windows a port held by another tunnel/socket opened for exclusive use — or
  inside a reserved range (Hyper-V/WSL `netsh` reservations) — surfaces as
  `WSAEACCES` (`PermissionDenied`), which slipped through and broke the
  connection. The fallback now also covers `PermissionDenied` and
  `AddrNotAvailable`, retrying on an OS-assigned port. The reassignment is
  logged to the Console (not just stderr) so it isn't invisible.

## [1.0.4] — 2026-06-06

### Added

- **CLI `--password`/`--pass` flag and `--user` alias.** The password can now be
  supplied on the command line for both `--connect-profile` (overriding the
  stored keychain secret) and ad-hoc launches; when present the app
  auto-connects without the password dialog. The password is used **in memory
  only** — it is handed straight to `connect` and never written to the OS
  keychain. `--user` is accepted as an alias for `--username` to match the
  spelling used by `psql`/`mysql`.

### Fixed

- **Main panel titles stayed in English under a Spanish UI.** The outer dockview
  panels (Schema, Saved, Workspace, Console, Cell) had hard-coded English
  titles, baked into the persisted layout, so they never followed the selected
  language. Titles are now sourced from i18n, re-applied after a layout restore,
  and updated live when the language changes. The View → Panels checkboxes use
  the same translated labels. Inner workspace tab fallbacks (the `Query`/`Table`
  default labels and the `(structure)` suffix on structure-editor tabs) are now
  localized too.

- **MySQL `LONGTEXT`/`TEXT` rendered as a hex blob.** sqlx names a column
  `LONGBLOB`/`BLOB` (vs `LONGTEXT`/`TEXT`) from the protocol-level `BINARY`
  column flag, which the server sometimes sets on real text columns depending
  on charset/collation — so a `LONGTEXT` field could surface as a hex dump
  (HeidiSQL showed it as text). The decoder now tries a UTF-8 `String` decode
  first and only falls back to hex for genuinely non-UTF-8 bytes.

- **SSH tunnel broke when the configured local port was already in use.** If
  another process (e.g. a second tunnel the user opened by hand) held the
  pinned `local_port`, the bind failed with `AddrInUse` and the connection
  errored out. The tunnel now falls back to an OS-assigned ephemeral port and
  keeps working; the pool follows the actually-bound port and the saved profile
  is left untouched.

- **SSH tunnel form fields overflowed the dialog.** When reconfiguring an
  existing tunnel, long values (notably the private-key path) pushed inputs and
  the "Browse" button past the dialog edge. Added `min-w-0`/`flex-1`/`shrink-0`
  constraints so fields shrink within the dialog instead of overflowing.

- **MySQL `BIT` column write — `insert_row` path.** `RowValue` now carries an
  optional `column_type` field. When the frontend builds the draft-row INSERT
  payload it populates `columnType` from `result.columns`, and the backend
  builds `CAST(? AS UNSIGNED)` placeholders for every MySQL `BIT` column
  instead of plain `?`. Previously, binding a string like `"1"` to a `BIT`
  column stored the ASCII byte `0x31` (49) rather than the integer 1 — for
  wide `BIT(n)` columns this silently wrote the wrong value every time.

- **MySQL `BIT` column write — `update_cell` path.** Added
  `normalize_bit_value` preprocessing so that the string handed to
  `CAST(? AS UNSIGNED)` is always a digit string. Without this, if the cell
  editor produced `"true"` or `"false"` (e.g. after the user typed those words
  in the Monaco editor), MySQL would evaluate `CAST('true' AS UNSIGNED)` as 0
  regardless of the intended bit value.

## [1.0.3] — 2026-06-03

### Added

- **Command palette hint in the status bar.** A small `Ctrl+K` chip now sits
  in the bottom-right status bar. Clicking it opens the command palette
  directly; hovering shows the full tooltip ("Command palette (Ctrl+K)"). The
  label uses a dynamic import so it never blocks the status bar render.

- **Command palette (`Ctrl`/`Cmd`+K).** A keyboard-first launcher for the
  actions otherwise buried in menus: switch or connect a database, open a table
  from the active connection's schema, start a query, switch theme or language,
  and open Preferences. Built on the bundled Radix dialog plus a filtered list —
  no new dependency. Because Monaco swallows `Ctrl`+K inside the editor, the
  query editor registers its own editor-scoped command so the palette opens
  regardless of focus (gotcha #9).
- **Active-connections dropdown in the status bar.** The comma-joined list of
  open connections is now a dropdown: live pools at the top (click to jump to
  that workspace, or disconnect inline), saved-but-idle profiles below for
  quick-connect. Connect / disconnect mirror the File menu flow exactly.
- **Richer status bar.** Adds a live multi-row **selection count**, a
  **read-only** marker for query-result tabs, a clickable **query-history**
  popover (open a recent query in a fresh tab, or copy it when its connection is
  offline), and quick **row-density** and **light/dark** toggles.
- **"What's new" patch notes in Preferences → About.** A per-version reader
  sourced from the bundled `CHANGELOG.md`, defaulting to the installed version.
  When the UI language is Spanish it reads a parallel `CHANGELOG.es.md`, falling
  back to the English body for any version not yet translated.
- **Active database marker in the multi-DB explorer.** When the schema-explorer
  filter is scoped to a database (the HeidiSQL-style behaviour shipped in 1.0.2),
  that database now carries an emerald dot and icon while the other databases are
  dimmed, so it's obvious at a glance which database the filter will hit — no
  longer only inferable from the filter input placeholder. With no database
  active (cross-DB / MongoDB-style search) every database stays at full opacity,
  since they're all in scope.

### Changed

- **Themeable brand accent.** The previously all-neutral palette gains one
  saturated accent colour reserved for action / state — primary buttons, focus
  rings, links, and the live-connection markers. It's a per-theme `brand` token
  (themes.ts): the neutral Dark / Light presets get a blue (`#0f83fd`) while the
  themed presets (Claude, Solarized, Dim, High Contrast) keep their own
  character. Custom themes saved before the token existed inherit a CSS default
  rather than breaking. A `prefers-reduced-motion` rule collapses the UI's
  transitions for users who ask for less motion.
- **"Island view" window layout.** The outer panel shell (Schema / Saved /
  Workspace / Console) now lays its panels out as spaced, rounded cards over a
  subtle backdrop instead of edge-to-edge regions, giving each window a small
  margin and clearer separation. The inner tab area (open tables and queries)
  stays flush and unchanged.

### Fixed

- **Duplicate "▶ Run" CodeLens (and duplicate autocomplete entries) with
  multiple query tabs open.** Monaco's `registerCompletionItemProvider` /
  `registerCodeLensProvider` / `registerCommand` are global to the language,
  but they were registered inside every query editor's `onMount`, so each open
  query tab added another provider — N tabs produced N "▶ Run" lenses on every
  statement and N copies of each suggestion. The providers are now installed
  once per Monaco instance (`src/lib/monacoSql.ts`) and dispatch per model via a
  registry each editor registers into on mount and removes on unmount.
- **Inner workspace tab strip readability + active-tab tracking.** The active
  query/table tab now carries a brand-tinted accent and tracks the active panel
  correctly (the custom tab derives its active state from the store rather than
  a stale `props.api.isActive`), the strip is taller with clearer hover states,
  and the close / split (⋮) / new-query (+) icons are legible on dark themes.
- **Incomplete Spanish translation.** Several panels and dialogs still rendered
  English regardless of the selected language. Migrated the Console panel, the
  query editor (history sidebar, tooltips, empty states, run hints), the Saved
  Queries panel, the Save Query dialog, the inline cell input, the connection
  error boundary, the data-grid right-click context menu (copy, copy-row-as,
  set NULL, filter by / excluding value, insert / duplicate / delete row, and
  the multi-row bulk actions), the data-grid toolbar (row filter, row count,
  insert, server-side filter chips) and the table browser toolbar (refresh,
  pagination, page size, loading state and the delete-confirmation dialog) to
  the i18n system. Spanish now covers the whole UI.

## [1.0.2] — 2026-06-02

### Added

- **Import / Export of connection profiles.** Export all or selected profiles to
  a portable JSON file (`File → Export profiles…` or the icons in _Manage
  connections_). Profiles can optionally include credentials: each password and
  SSH secret is encrypted individually with AES-256-GCM, key-derived via
  PBKDF2-HMAC-SHA256 at 600 000 iterations, so the file is safe to store or
  send. Importing detects encryption, walks through a passphrase step when
  needed, shows a conflict-resolution screen when IDs collide (overwrite / skip /
  keep both), and always assigns fresh UUIDs to imported profiles to avoid
  keychain collisions. Profiles imported without passwords are flagged in the
  result summary.
- **CLI connection arguments.** HuginnDB can now be launched with connection
  flags so external tools can open it pre-connected. `--connect-profile <name>`
  auto-connects to a saved profile by display name; `--connect-profile-id <uuid>`
  uses the stable ID instead. For ad-hoc connections without a saved profile:
  `--host`, `--port`, `--database`, `--username`, `--driver`, `--name` — the
  app opens with the profile pre-populated and asks for the password via the
  normal dialog (passwords are never accepted on the CLI). Unknown flags are
  silently ignored for forward compatibility.
- **Scoped multi-DB filter (HeidiSQL-style).** In multi-database connections,
  the schema-explorer filter now scopes to the active database instead of
  searching all databases simultaneously. Expanding a database activates it as
  the filter scope; the search input placeholder updates to "Filter in
  `<db>`…" and a hint below the input confirms the scope while typing. Opening
  a table from cross-DB results automatically activates that database, collapses
  the others, and fixes the scope. With no database expanded the filter falls
  back to the previous behaviour (searches all DBs), keeping the single-DB case
  fully retrocompatible.
- **Visual table-structure editor (HeidiSQL-style).** Right-click a table →
  _Edit structure…_ (or _New table…_) opens an editor for columns
  (add/drop/rename, type, nullability, default, primary key, auto-increment),
  indexes and foreign keys — including composite ones. The column type is an
  editable combobox pre-filled with the driver's common types so you avoid
  typos but can still fine-tune (e.g. `varchar(40)`). It follows a
  preview-and-apply model: the backend generates driver-aware DDL (PostgreSQL /
  MySQL / SQLite) which is shown in a live read-only preview before you apply it
  in one go. On SQLite, changes that `ALTER TABLE` can't express (type /
  nullability / PK / FK edits) fall back to the canonical 12-step table rebuild,
  gated behind an explicit destructive confirmation. All identifiers are
  validated before quoting; types and defaults go through a conservative
  allowlist.
- **Side-panel cell editor (JetBrains-style).** Large cell values can now be
  edited in a docked right-side panel instead of a centered dialog. Reach it via
  right-click → _Open in side editor_, or the new _Move to side panel_ button
  inside the modal editor (it carries the in-progress buffer across). A new
  _General → Cell editor_ preference (`cellEditorMode`: Dialog / Side panel)
  chooses where the editor opens when you expand a cell. The panel is a real
  dockview panel, so it resizes, docks and floats like the others.
- **Multi-row selection with bulk copy and delete.** Pick several rows the way
  your OS file manager works: `Ctrl`/`Cmd`-click toggles individual rows and
  `Shift`-click extends a contiguous range. Right-clicking the selection offers
  _Copy N rows as ▸ JSON / SQL INSERT / SQL UPDATE_ (reusing the existing per-row
  formatters) and _Delete N rows_. Every delete — single or bulk — goes through
  the same confirmation dialog. Selection is keyed by primary key, so it
  survives sorting, client-side filtering and refetches (only available on
  tables with a primary key).
- **Workspace split/float layout now persists per connection.** A two-pane (or
  floating) arrangement inside a workspace is captured as a dockview `toJSON()`
  blob in `tab_state.json` (`internalLayout`) and restored with `fromJSON` on
  reopen, instead of always coming back as plain tabbed panels. Only saved when
  a split actually exists; on any layout drift it falls back to the tabbed
  default.

### Fixed

- **Editing a MySQL `BIT` cell wrote garbage.** `update_cell` sends the value
  as a textual literal and lets the driver coerce it. For `BIT`, MySQL reads the
  string `"1"` as the ASCII byte `0x31` (the character `'1'`) instead of the
  integer 1, so saving a BIT cell silently corrupted it — while `VARCHAR`/`TEXT`
  worked because they accept the string directly. The frontend now forwards the
  column's raw type to `update_cell`, which wraps the placeholder in
  `CAST(? AS UNSIGNED)` for MySQL `BIT` columns (NULL-safe), forcing numeric
  interpretation. PG/SQLite are unchanged.
- **MySQL `TINYINT` (and other non-`i64` integer widths) rendered as `NULL`.**
  sqlx maps each MySQL integer width to a specific Rust type (`TINYINT` → `i8`,
  `… UNSIGNED` → `u8`/`u32`/`u64`, …) and refuses a mismatched `try_get` target,
  so `try_get::<i64>` failed for everything that wasn't signed-64-bit-compatible
  and the cell collapsed to `NULL` — the same class of bug previously fixed for
  `BIT`. `mysql_value` now falls back across the signed and unsigned widths
  before surrendering to `NULL`, so `TINYINT`/`SMALLINT` and unsigned columns
  show their real value. `TINYINT(1)`/`BOOL` still decode as booleans (that
  branch stays above the generic `INT` check).
- **Blank connection panel when clearing a multi-DB filter.** In a multi-database
  connection, typing a filter and then clearing it could blank the entire schema
  panel (the outer File/View/Workspaces toolbar stayed visible). Root cause: a
  `useMemo` in the single-database explorer sat _below_ the `if (!cs) return`
  early return, so when the per-connection schema slice briefly flipped to
  `undefined` while nested explorers unmounted, React rendered a different number
  of hooks across renders and threw. The hook now sits above the early return
  (constant hook count) and the grouping is reference-stable. A new
  `ConnectionErrorBoundary` wraps the schema and workspace panels so any future
  render crash degrades to a legible error card with a retry instead of a dead
  white screen.

## [1.0.1] — 2026-05-30

First patch release. Fixes the MySQL `BIT` rendering that 1.0.0 shipped
broken, and reworks data-grid cell editing into an inline-first flow with a
persisted HeidiSQL-style row zoom. On-disk state is untouched.

### Added

- **Inline cell editing.** Double-clicking a cell in the data grid now edits
  it in place with the same single-line input used by the insert draft row,
  instead of always opening the large Monaco dialog. A _expand_ button on the
  inline editor (and the existing F11 in the cell preview) escalates to the
  full modal for JSON / long / multi-line values. Foreign-key columns keep
  their inline combobox; read-only query results still open the modal as a
  viewer. The plain input + `∅` set-NULL control is now a shared `CellInput`
  component reused by both the draft row and inline editing.
- **Persisted row zoom.** The data grid honours `gridPrefs.rowHeight` (a
  HeidiSQL-style zoom): `Ctrl` + mouse-wheel over the grid and `+`/`−` buttons
  in the table toolbar grow or shrink row height, padding and font-size
  together. The level is stored in `prefs.json` and survives restarts.

### Fixed

- **MySQL `BIT` columns rendered as `NULL`.** `sqlx` refuses to decode a
  `Vec<u8>` from a `MYSQL_TYPE_BIT` column (its blob type-compatibility check
  only accepts BLOB/STRING/VARBINARY), so the value collapsed to `NULL` in the
  grid even though the row held a real value. `mysql_value` now reads the bytes
  straight off the `ValueRef`, folding them big-endian into an integer
  (`BIT(1)` → 0/1, wider `BIT(n)` → its numeric value). Booleans
  (`BOOL` / `TINYINT(1)`) are also now decoded before the generic `INT` check,
  which previously shadowed them.

## [1.0.0] — 2026-05-29

First stable release. The alpha cycle (0.x) closes with the workspace
turning into a code-editor-style surface, the multi-database explorer
becoming instant on the first keystroke, and two MySQL-specific defects
fixed. Existing data on disk (`profiles.json`, `tab_state.json`,
`prefs.json`) is preserved without migration. From here on the project
follows SemVer.

### Added

- **Editor-style workspace.** The open table and query tabs now live in a
  nested dockview instance instead of a flat tab strip, so the workspace
  behaves like a code editor: tabs can be split horizontally or
  vertically, dragged between groups, and torn out into a floating
  window. Tabs can also be closed with a middle-mouse (wheel) click in
  addition to the X button. Each tab also exposes an explicit `⋮` menu
  with _Split right_, _Split down_, _Float in new window_, and _Close_
  for users who prefer menu actions over drag-and-drop. `useTabs` remains
  the source of truth — the dockview panels are reconciled against it —
  so the existing per-connection tab restore keeps working. Split/float
  geometry is session-only; restored tabs come back in the default tabbed
  layout.

- **MySQL `BIT` columns are now configurable in the grid.** A new
  **BIT display** preference (Settings → Grid) renders `BIT` values as
  either `true`/`false` (default) or `0`/`1`. The backend always ships
  the value as a number, so toggling the preference re-renders without
  re-querying.

### Changed

- **Multi-database filtering is now instant.** The connection-level
  filter used to fan out `openDatabaseView` + `list_tables` across every
  database on the _first_ keystroke, so the initial search on a server
  with many databases stalled for seconds. A multi-DB connection now
  warms its entire table cache in the background as soon as the database
  list is known (`warmDatabases` in `src/stores/schema.ts`), with bounded
  concurrency so it never opens every pool at once. The filter reads
  straight from that cache; a subtle progress line shows how many
  databases remain. The previous on-demand prefetch is retained as a
  fallback for databases the warm pass hasn't reached yet.

### Fixed

- **HTML5 drag-and-drop in the workspace was completely broken on
  Windows.** Dragging an editor tab produced the "no drop allowed"
  cursor everywhere on screen — no drop overlay appeared, nothing
  accepted a release. Tauri 2's `dragDropEnabled` defaults to `true`,
  which routes drag events through the OS file-drop handler and preempts
  the HTML5 events dockview's `Droptarget` listeners rely on
  (`tauri-utils` documents this verbatim: _"Disabling it is required to
  use HTML5 drag and drop on the frontend on Windows"_). The window
  config now sets `dragDropEnabled: false`. HuginnDB doesn't accept OS
  file drops anyway (the SQLite path is chosen via a file dialog), so
  there's no functional loss.

- **Split divider between dockview groups was nearly invisible.**
  `.dv-sash` was forced to z-index 1 (so Radix portals always covered
  it) and tinted with `--border`, which on the dark theme blended into
  the panel content. A vertical split looked like nothing had happened
  even when dockview had laid out a new group below. The sash now lives
  at z-index 10 (still safely under Radix at 50) with an explicit
  divider tint, and the drag-over fill jumped from 0.18 to 0.40 alpha so
  the drop quadrants stand out over Monaco / grid surfaces.

- **"Split right" / "Split down" actions in the tab `⋮` menu silently
  did nothing.** They called `panel.api.moveTo({ position })` without a
  `group`, but `DockviewPanelApiImpl.moveTo` coerces `position` to
  `"center"` whenever `options.group` is undefined — moving the panel
  to the centre of its own group is a no-op. Passing the panel's own
  group as the reference makes dockview create a new group adjacent at
  the requested side.

- **MySQL/MariaDB raised error 1064 when filtering a table.** The
  cross-column search clause emitted `... LIKE ? ESCAPE '\'` for every
  driver. On MySQL the backslash inside the string literal escapes the
  closing quote, leaving it unterminated and triggering a syntax error
  (the filter still returned rows because the data and `COUNT(*)`
  queries run separately, but the error banner appeared). The `ESCAPE`
  clause is now driver-aware: MySQL receives `ESCAPE '\\'` (parsed as a
  single backslash, matching `escape_like`), while Postgres/SQLite keep
  the standard-SQL `ESCAPE '\'`. Centralised in a new
  `like_escape_clause` helper used by both the table filter and the FK
  options lookup (`src-tauri/src/commands/query.rs`).

- **MySQL `BIT` columns rendered as NULL.** `mysql_value`
  (`src-tauri/src/db/values.rs`) had no branch for `BIT`, so sqlx's
  binary value fell through to the `String` fallback, failed to decode,
  and surfaced as NULL. A dedicated branch now folds the raw bytes into
  a big-endian unsigned integer and ships it as a number.

## [0.7.2] — 2026-05-22

Two bugs reported against 0.7.1 demanded an immediate follow-up: the
multi-database explorer rendered a blank panel as soon as a profile
listed more than one database, and saving a cell on a table with a
composite primary key silently overwrote every row sharing the leading
PK column's value. Both are fixed here. The 0.7.1 changelog entry,
inadvertently shipped in Spanish, is also translated to English so the
whole file reads consistently.

### Fixed

- **Multi-database connections rendered a blank panel.** The
  MongoDB-Compass-style filter added in 0.7.0 placed a `useMemo` below
  the `if (!cs) return <loading/>` early return inside
  `MultiDbExplorer` (`src/components/SchemaExplorer.tsx`), which is a
  Rules of Hooks violation: React called fewer hooks on the first
  render (before the schema slice existed) than on subsequent renders
  (after `refresh` populated `cs`), corrupted the hook order, and
  bailed out with an empty tree. Single-DB profiles never hit the code
  path so the regression only affected multi-DB ones. The memo now
  lives above the early return, is defensive against an undefined
  `cs`, and carries a comment documenting why its position matters —
  matching the broader gotcha already documented in `CLAUDE.md`.

- **Cell save and row delete corrupted data on tables with composite
  primary keys.** The schema introspection correctly flags every
  column participating in the PRIMARY KEY constraint
  (`information_schema.table_constraints` on Postgres,
  `column_key='PRI'` on MySQL, `pk > 0` on SQLite), but the frontend
  in `src/components/TableDataTab.tsx` used
  `cols.find(c => c.is_primary_key)` and shipped only the _first_ PK
  column to `update_cell` and `delete_rows`. The resulting
  `WHERE leading_pk_col = ?` predicate matched every row sharing that
  leading value, so editing a single cell with a filter active rewrote
  every filtered row, and deleting a row removed its siblings. The
  Tauri commands now take `pk_columns: Vec<String>` and
  `pk_values: Vec<Value>` (single-row UPDATE) /
  `pk_value_rows: Vec<Vec<Value>>` (multi-row DELETE) and build the
  full `WHERE c1 = ? AND c2 = ? AND …` / `WHERE (c1, c2) IN ((?, ?), …)`
  predicate. `TableDataTab` reads every `is_primary_key=true` column
  from `list_columns` and feeds the parallel tuple through
  `pkValuesFromRow`. As an extra safety net, `update_cell` now wraps
  the UPDATE in a transaction and rolls back if `rows_affected > 1` —
  impossible with a correct PRIMARY KEY but a useful assertion against
  any future regression of this family. `delete_rows` validates the
  arity of every supplied tuple against `pk_columns.len()` and returns
  a structured error on mismatch instead of building a malformed
  query. The "Copy row as ▸ SQL UPDATE" snippet in `copyFormats.ts`
  was updated to AND-join every PK column too, keeping clipboard
  snippets paste-safe on composite-PK tables.

### Changed

- **CHANGELOG 0.7.1 entry translated to English.** The published 0.7.1
  release notes were shipped in Spanish by mistake. The body is
  reproduced verbatim below (under the original 0.7.1 heading) but
  now in English, with no semantic change to the release contents.

## [0.7.1] — 2026-05-21

Brand-identity patch. Replaces the placeholder green "H" icon with
HuginnDB's official logo (a Nordic eye on a dark background, app-icon
style with rounded corners). No functional changes.

### Changed

- **New official logo.** Every application icon in `src-tauri/icons/`
  was regenerated from the new source `huginn-app-icon-512.png` via
  `pnpm tauri icon`. The previous logo (a letter "H" inside a green
  circle) is replaced across every platform: Windows (`.ico`, APPX
  squares, Store Logo), macOS (`.icns`), Linux (PNGs), iOS and
  Android.

- **Brand-identity assets added.** `public/image/` now ships the
  official logo variants: `huginn-app-icon` at 1024/512/256/128/64 px
  plus the SVG marks (`huginn-mark`, `huginn-mark-black`,
  `huginn-mark-white`, `huginn-mark-blue`, `huginn-mark-runes`) for
  use on the web, in the docs, and in marketing material.

## [0.7.0] — 2026-05-21

Likely the last release of the alpha line. Closes the cell-edit
corner case under client-side filtering that bit us across 0.5.0 and
0.6.0, finishes the SSH-tunnel UX (keychain prompt now fires on Test
too), turns the multi-DB explorer into a real cross-database search,
and finally exposes Monaco's themes + font as user preferences with
One Dark Pro as the new default.

### Added

- **VS Code-style Monaco themes + font customisation.** Settings →
  Editor now exposes a theme picker with One Dark Pro (the new
  default), GitHub Dark, GitHub Light, Monokai, Solarized Dark,
  Solarized Light, and Monaco's built-in `vs-dark` / `vs-light`. The
  font family and font size inputs already lived in the dialog but
  were ignored by the editors; they're now wired to the live Monaco
  instances (both the SQL editor in query tabs and the cell editor
  dialog). Theme definitions are bundled in
  `src/lib/monaco-themes.ts` — no `monaco-themes` npm dependency, no
  CDN fetch (gotcha #2 in `CLAUDE.md`). `prefs.json` learns a new
  `editor.theme` field; older files default to `one-dark-pro` on
  load via `serde(default)` on the Rust side and `resolveMonacoTheme`
  on the frontend.

- **MongoDB-Compass-style filter in the multi-database explorer.**
  Typing in the connection-level search box now prefetches the table
  list for every database on the server (debounced 250 ms, fan-out
  gated on needle length ≥ 2 so a single accidental keystroke doesn't
  hammer the catalog) and auto-expands every database whose tables
  match the needle. Databases with no matches drop out of the list
  while the filter is active; databases that match by _name_ are
  surfaced collapsed so the user can pick them. Clearing the search
  instantly restores the full list. The previous behaviour only
  surfaced matches inside DBs the user had already opened by hand —
  matching across the whole server required opening every DB
  manually first.
- **SSH tunnel credentials now go through the OS keychain on Test, not
  just on Save.** Creating a profile with a tunnel used to skip the
  credential prompt during the Test round-trip — the SSH secret stayed
  in memory until the user hit Save, which made it unclear whether the
  password had actually been persisted. `test_connection` now writes
  the supplied SSH secret to the keychain under
  `<profile.id>::ssh::<ssh_user>` _before_ `smoke_test`, matching the
  UX already in place for the DB password. To keep the keychain
  account stable between Test and Save for brand-new profiles, the
  connection dialog pre-mints a UUID on open via `crypto.randomUUID()`
  and threads it through `buildProfile()`; `save_profile` already
  treated a supplied id as authoritative, so this is a no-op there.

### Fixed

- **Duplicate database node in multi-DB MySQL / SQLite explorers.**
  Expanding a database in multi-DB mode used to render _the same
  database name_ a second time with a Database icon underneath,
  with tables and indexes nested one extra level. The culprit was
  the synthetic child connection's `list_tables` reporting every
  table's `schema` as the database name itself (MySQL's
  `DATABASE()`, SQLite's hard-coded `"main"`), which the nested
  `SingleDbExplorer` then dutifully grouped under a per-schema
  header. The nested explorer now flattens away that header when
  there's exactly one schema, so tables / views / indexes sit
  directly under the database node. Postgres multi-DB with multiple
  user schemas (`public`, custom namespaces, …) keeps the per-schema
  header.
- **Cell save under an uncommitted toolbar filter no longer appears to
  bleed into the row above.** The grid used to receive the live
  toolbar draft as `globalFilter` while the backend page was built
  from the committed value (`appliedFilter`); the two diverged
  whenever the user was typing without having pressed Enter, so the
  client-side `visibleRows` pass hid a different subset than the rows
  the backend had returned. On save + refetch, the viewport
  reshuffled and a neighbour visually inherited the edited cell's
  position — same family of bug as gotcha #7 in `CLAUDE.md` (PK
  lookup vs filtered-display index). `DataGrid` now takes a separate
  `filterInput` prop for the toolbar value, keeping the applied
  filter and the displayed input independent.
- **Cell metadata is resolved by column name, not by visible-cells
  position.** `row.getVisibleCells()` walks TanStack's display order;
  the previous render indexed `result.columns[colIdx]` and
  `rowValues[colIdx]` with that position, which would silently
  misalign meta and value the first time anyone introduced column
  hiding or reordering. A memoised `columnIndexByName` map now
  resolves both off `cell.column.id`.

## [0.6.0] — 2026-05-20

Companion release to 0.5.0 that tackles the SQL editor pain points
deliberately deferred from that one: a broken Ctrl+Enter, no way to
run a single statement when the editor holds several, and an
IntelliSense provider that only surfaced raw table / column names.

### Added

- **Per-statement run via CodeLens.** A small "▶ Run" appears on the
  first line of every `;`-delimited statement; clicking it executes
  only that fragment without touching selection state or having to
  highlight the right chunk by hand. Statement boundaries come from a
  new `src/lib/sqlSplit.ts` parser that understands single-quoted
  strings, double-quoted identifiers, backticks (MySQL), line and
  block comments, and Postgres dollar-quoted strings (`$$ … $$`,
  `$tag$ … $tag$`) so a `;` inside any of those does not split the
  statement. The gutter refreshes on every buffer edit via a
  `Monaco.Emitter` wired to the CodeLens provider.
- **Driver-aware SQL keywords in autocomplete.** The completion popup
  now blends tables, columns and a curated keyword catalogue
  (`COMMON` plus a Postgres / MySQL / SQLite overlay — `RETURNING`,
  `ON DUPLICATE KEY UPDATE`, `PRAGMA`, etc.). Ordering is enforced
  via `sortText` prefixes: tables first, then columns, then keywords,
  so a partial match never buries the user's table behind a
  long-tail keyword. The Monaco wiring moved into pure helpers
  (`lib/sqlKeywords.ts`, `lib/sqlCompletions.ts`) so it's testable in
  isolation and easy to evolve. Column names are deduplicated across
  tables; the `detail` field reports how many tables a shared column
  appears in.

### Fixed

- **`Ctrl+Enter` in the SQL editor did not run the query.** The
  previous binding lived on `window.addEventListener("keydown", …)`,
  but Monaco's own command layer captures `Ctrl+Enter` inside the
  editor focus area before the window listener gets a chance to fire,
  so the shortcut only worked when the editor wasn't focused — i.e.
  never, in normal use. The shortcut is now bound via
  `editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, …)`, registered
  exactly once during `handleMount` and dispatched through a ref that
  tracks the live `runQuery` callback (so the closure isn't frozen to
  the first render's `sql`). Documented as gotcha #9 in CLAUDE.md.

### Internal

- `QueryEditorTab` grew refs for the live `runQuery`, the live
  completion list and the live CodeLens cache so the
  register-once-handlers Monaco demands can still see freshest state
  without re-registering on every render.

## [0.5.0] — 2026-05-20

A second feedback-driven release. After 0.4.0 was shown to colleagues
inside a corporate setting, four pain points kept coming up: cell edits
under an active client filter silently writing to the wrong row, one
filter input per database in multi-DB connections, a missing
"Copy row as …" affordance in the grid context menu, and the lack of a
real workspace concept for grouping per-connection tabs by mental
context (work, personal, projects). This release tackles all four. The
SQL editor pain points (Ctrl+Enter, per-statement run, richer
IntelliSense) are deliberately deferred to 0.6.0 so the data-grid and
session bugs can ship without waiting on the editor rework.

### Added

- **Workspaces.** A workspace bundles a name, an optional accent colour
  (eight curated swatches), an optional icon (nine lucide picks) and the
  per-connection tab state for everything the user touched while it was
  active. A switcher in the topbar (`WorkspaceSwitcher.tsx`) hosts a
  sortable list (via `@dnd-kit/sortable`), inline rename / colour /
  icon / delete actions, and a "New workspace" dialog. Switching does
  **not** close pools; it flushes pending tab-state writes for every
  open connection, flips the active pointer in `tab_state.json`, and
  re-hydrates each open connection's tabs from the new workspace.
  Backend persistence lives in `tab_state.rs v2` (the v1 blob is
  transparently migrated into a single "Default" workspace on load).
  New Tauri commands (`list_workspaces`, `get_active_workspace_id`,
  `create_workspace`, `rename_workspace`, `update_workspace_appearance`,
  `delete_workspace`, `reorder_workspaces`, `set_active_workspace`)
  plus a frontend Zustand store (`stores/workspaces.ts`) glue the two
  together. The existing `get_tab_state` / `save_tab_state` /
  `clear_tab_state` commands now transparently scope to the active
  workspace; `clear_tab_state` and the profile-deletion sweep operate
  across every workspace so a deleted connection cannot leave dangling
  tabs in workspaces the user is not currently looking at.
- **"Copy row as …" submenu in the data-grid context menu.** Three
  destinations: JSON (object keyed by column name, pretty-printed),
  SQL `INSERT` (qualified table + every column), SQL `UPDATE` (every
  non-PK column in `SET`, primary key in `WHERE`). Snippets are
  driver-aware — MySQL uses backticks, Postgres and SQLite use double
  quotes. The serialisers live in the new `src/lib/copyFormats.ts` so
  they can be reused later by other surfaces (CellPreview, query
  history exports). The Radix context-menu wrapper grew matching
  `Sub`, `SubTrigger`, `SubContent` primitives so the submenu fits the
  rest of the app's chrome.
- **Connection-level filter in the multi-database schema explorer.**
  Multi-DB connections (Postgres / MySQL profiles saved with an empty
  `database` field) used to render a separate filter input under every
  expanded database, which forced users to retype the same needle once
  per database. The filter input is now lifted to the connection
  header and propagated through every nested `SingleDbExplorer` via a
  new `controlledFilter` prop. Single-DB connections (SQLite, Postgres
  / MySQL with a fixed catalog) keep their original behaviour.

### Fixed

- **Data corruption when editing a cell with a client-side filter
  active.** The `DataGrid` used to pass the TanStack `row.index`
  (filtered display index) to `onCellSave`, while `TableDataTab`
  resolved the PK by reading `result.rows[index]` — the unfiltered
  backend page. Once `globalFilter` reshuffled the displayed rows the
  two indices diverged silently and the `UPDATE` landed on whichever
  row happened to sit at the same offset in the backend page. The
  contract now passes the row's full value array (`row.original`)
  instead of an index; the parent resolves the PK from the data,
  immune to client-side reshuffling. `onDeleteRow` and `onDuplicateRow`
  follow the same shape. Cell selection state (`SelectedCell`,
  `editorTarget`, `fkEditCell`) was reshaped accordingly so an edit
  started before a filter change continues to address the correct row
  after.

### Internal

- New dependencies: `@dnd-kit/core`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities` — used by the workspace switcher's drag-and-drop
  reorder. Adds three small (~30 kB total) packages to the bundle but
  saves a non-trivial amount of bespoke pointer-handling code.
- `tab_state.rs` grew a `RawState` helper struct used only by
  `load_tab_state` to deserialise both v1 and v2 blobs in one pass,
  with the migration centralised inside `RawState::into_state`.

## [0.4.0] — 2026-05-19

A phased release driven by feedback from real-world use of the 0.3 series
inside a corporate environment. Bundles correctness fixes, multi-database
browsing, a new schema-tree context menu, an updated notification UI, two
new built-in themes, draggable tabs, and broader i18n coverage.

### Added

- **Multi-database browsing for connections without a default database.**
  When a Postgres or MySQL profile is saved with an empty `database` field,
  the schema explorer now lists every database the user can see on the
  server as a top-level node. Expanding one lazily spawns a synthetic
  `<connection_id>::db::<db>` pool (via the new `open_database_view`
  command) and the nested subtree behaves like a regular schema explorer
  scoped to that database — tables, views, columns, data tabs and editing
  all work end-to-end. Previously, leaving the database blank left the
  tree empty because `list_tables` had no current DB to enumerate.
  Synthetic child pools are torn down when the parent connection
  disconnects, and the matching tab / schema-cache slices are purged on
  the frontend.
- **Right-click context menu on tables in the schema explorer.** Each
  table row now exposes Open / Copy name / Copy SELECT / Refresh, plus
  the destructive **Rename** and **Drop table** actions on base tables.
  Rename opens a small dialog; Drop requires the user to retype the
  table's name before the confirm button enables (same UX as GitHub's
  repository deletion). DDL goes through two new Tauri commands,
  `rename_table` and `drop_table`, that build the statement with
  `quote_ident` on catalog-sourced names (per `SECURITY.md`). Views
  intentionally only show the read-only actions.
- **Filter input above the schema tree.** Substring match (case
  insensitive) across all table and view names. When the filter is
  active, matching schemas/sections auto-expand so results are visible
  without further clicks.
- **Drag-to-reorder tabs in the workspace tab strip.** Native HTML5
  drag-and-drop with a primary-coloured drop indicator on the target.
  Tab order is reflected in the in-memory store and therefore survives
  the next persisted-workspace snapshot.
- **Two new built-in themes: Claude Light and Claude Dark.** Warm paper /
  sepia palette with a terracotta primary, taken from the Claude product
  identity. Available under Preferences → Appearance alongside the other
  built-ins; switching is live and respects the same custom-theme fork
  flow as the other built-ins.

### Fixed

- **MySQL `DATETIME` / `TIMESTAMP` / `DATE` / `TIME` / `YEAR` columns rendered
  as NULL in the data grid.** `mysql_value()` in `db/values.rs` only had branches
  for numerics, JSON and BLOB types; temporal columns fell through to the
  generic `try_get::<String>` fallback, which fails to decode and returns
  `Value::Null`. HeidiSQL shows them correctly because its C connector decodes
  temporals as strings by default. Added explicit branches that decode through
  `chrono::NaiveDateTime`, `DateTime<Utc>` (for `TIMESTAMP`, since MySQL stores
  it in UTC and converts on read), `NaiveDate`, `NaiveTime`, and a `u16` for
  `YEAR`. Postgres already had the equivalent matches.

### Changed

- **Redesigned update-available notification.** The previous Sonner toast
  in the bottom-right corner was easy to miss and looked stylistically
  out of place. Replaced with a top-centred `UpdateBanner` that takes
  full advantage of the available width: icon + version line + short
  description + clearly-prioritised "Install and relaunch" / "Later"
  actions, with a soft slide-down on appear and full theme awareness.
  Sonner remains available for short transient toasts elsewhere in the
  app.
- **Tabs now qualify their title with the connection name when 2+ connections
  are open.** Previously, opening the same table (e.g. `users`) on two
  connections produced two indistinguishable tabs both labelled `users`. The
  label now reads `cliente1 · users` / `cliente2 · users` whenever tabs from
  multiple connections coexist, and every tab carries a tooltip with the full
  `connection / schema.table` path. Synthetic per-database connections
  resolve as `<parent name> · <database>` in the tab label and tooltip. A
  single-connection workspace looks unchanged.
- **Broader i18n coverage.** Strings that previously remained English even
  when the Spanish locale was active (cell editor and cell preview chrome,
  tab-strip labels and tooltips, the new schema-explorer context menu and
  rename / drop dialogs) are now driven through `i18next`. The Spanish
  locale was extended to match. Strings inside Monaco itself still follow
  its own locale system and are out of scope for this release.

## [0.3.3] — 2026-05-18

### Fixed

- **MySQL schema explorer permanently stuck in loading state.**
  Root cause: `sqlx`'s `Row::get::<T>()` **panics** (instead of returning
  `Err`) when the Rust type does not match the column's type flags reported by
  the MySQL server. A panic inside an async Tauri command causes the IPC
  promise to hang indefinitely rather than reject, so the frontend never
  receives a response and `loading` never clears. This manifested on MySQL
  because `SHOW TABLE STATUS` and `information_schema` columns like `Rows`,
  `Data_length`, and `Index_length` are reported as signed or unsigned BIGINT
  depending on the MySQL version and distribution — `r.get::<u64>()` panics
  when the server reports the column as signed.

  Additionally, `information_schema.TABLES` can block indefinitely when an
  InnoDB metadata lock is held by a DDL statement or long-running transaction,
  compounding the hang. SQLite's `sqlite_master` has neither issue (in-memory,
  no metadata locking, no type-flag mismatch).

  Fix: replaced the `information_schema.TABLES` query with
  `SHOW TABLE STATUS FROM \`db\``, which is faster, not subject to metadata
lock waits, and returns a fixed column set. All numeric columns are now read
with `try_get`(returns`Result`instead of panicking) plus a signed/unsigned
fallback chain so the schema loads correctly on MySQL 5.7, 8.0, MariaDB, and
any fork regardless of how type flags are reported. The current database is
resolved via`SELECT DATABASE()`so the implementation no longer depends on`information_schema` at all for MySQL table listing.

## [0.3.2] — 2026-05-18

### Fixed

- **MySQL schema loading broken by two additional bugs.**
  1. _Infinite refresh loop._ The `SchemaExplorer` effect condition
     `!cs || !cs.initialized` fired on every state update while a fetch was
     in flight (`loading: true` creates a new object reference each time
     Zustand updates), launching a new concurrent `list_tables` call on every
     tick. MySQL's `information_schema.tables` is slow, so the pool was
     saturated by looping queries that never completed. Fixed by adding
     `!cs.loading` to the guard so the effect is a no-op while a fetch is
     already running. `initialized: true` is now also set in the error path so
     a failed fetch does not trigger the same loop.

  2. _`size_bytes` type mismatch on MySQL._ The expression
     `IFNULL(data_length, 0) + IFNULL(index_length, 0)` produces a **signed**
     `BIGINT` in MySQL (the integer literal `0` forces signed promotion even
     though both source columns are `BIGINT UNSIGNED`). sqlx's MySQL driver
     checks column type flags and rejects decoding a signed column as `u64`,
     causing `list_tables` to throw and schema loading to fail with an error.
     Fixed by decoding as `Option<i64>` then `unsigned_abs()` — same pattern
     already used on the Postgres path.

## [0.3.1] — 2026-05-18

### Fixed

- **Schema explorer blank after MySQL reconnect.**
  When a user connected to MySQL without a default database (empty `database`
  field in the profile), the schema fetch completed with zero tables. On
  subsequent disconnect + reconnect (now with a database specified), the stale
  empty slice was still in the Zustand store, so `SchemaExplorer`'s
  `useEffect` guard (`if (!cs)`) never re-triggered `refresh`. Two-part fix:
  (1) `disconnect()` now calls `schema.drop(id)` to clear the cached slice, so
  the next connect always starts from a clean state; (2) `ConnectionSchema` has
  a new `initialized` flag (set by `refresh` on success, never by
  `replaceExpanded`), and the explorer now triggers refresh when
  `!cs || !cs.initialized`, which also handles the race where workspace
  hydration initialises the slice with empty tables before the effect fires.

## [0.3.0] — 2026-05-18

This is the first release to ship an observability surface for the
runtime. Everything the app does against your databases — connect,
disconnect, every SELECT/INSERT/UPDATE/DELETE, the paginated table
browser, even the test-connection probe — is now visible in real time
through a new **Console** panel. The motivation was direct: we kept
hitting "the schema browser is stuck loading…" bugs with no way to tell
which Tauri command had gone silent. After this release that question
becomes a one-glance answer.

This is a `0.2.x → 0.3.0` minor bump rather than a patch because it
adds a brand-new docked panel, a new Rust module (`log_bus`), and a
permanent runtime event channel (`huginndb://log`). No breaking changes:
existing profiles, preferences, tab state, and on-disk layout all keep
working untouched.

### Added

- **Console panel — in-app SQL log, HeidiSQL-style.**
  Every backend operation that crosses the Tauri bridge now emits a structured
  `huginndb://log` event picked up by a new `Console` panel: SQL executed via
  `execute_query`, `fetch_table_data` (data + count statements are logged
  separately), `update_cell`, `delete_rows`, and `insert_row`, plus connection
  lifecycle events (`connect: start/ok/failed`, `disconnect`, and
  `test_connection`). The panel virtualises the list with `react-virtuoso`
  and renders the currently-selected entry in a Monaco read-only viewer that
  reuses the existing bundled instance — no new CDN dependency. Failures
  appear with a red border and the underlying driver error message, which
  makes "the schema browser is stuck loading…" debuggable: the last entry
  before silence pinpoints exactly which command never returned.

  The panel is registered with dockview alongside Schema / Saved / Workspace
  and is hidden by default; users open it from **View → Panels → Console**.
  Log state is session-only and capped at 2000 entries; the toolbar exposes
  pause/resume, clear, kind filters (SQL / Connection), and free-text search.

### Internal

- **`src-tauri/src/log_bus.rs`** — new module owning the on-the-wire
  `LogEntry` shape, a monotonic id source, and a fire-and-forget
  `emit()` helper. Emission failures are swallowed by design so logging
  can never break the originating DB call.
- **`try_sql!` macro in `commands/query.rs`** — collapses the six
  repeated `match q.await { Ok => …, Err(e) => { log; return Err } }`
  blocks down to a single line per call site while keeping each
  driver's bespoke row decoding (`pg_value` / `mysql_value` /
  `sqlite_value`) in the caller's control flow.
- **`react-virtuoso` (4.18.x)** added to `dependencies` — the only new
  package. ~30 KB minified, well-maintained, plain TS.

## [0.2.2] — 2026-05-18

### Added

- **In-app update notifications via `tauri-plugin-updater`.**
  At launch the app queries `https://github.com/Alexfp28/huginnDB/releases/latest/download/latest.json` and, if a newer signed release exists, shows a non-intrusive toast plus a persistent red dot on the settings gear. The Preferences → About panel exposes a manual "Check now" trigger, the release notes, and an "Install and relaunch" button that downloads the signed installer in-process and restarts the app. Dismissal is per-version: clicking "Later" silences the toast for that release but keeps the badge until the user actually installs. This is the first build that ships with the updater wired in, so users running 0.2.0 / 0.2.1 will need to update once by hand; future releases will be picked up automatically.

- **GitHub Actions release workflow (`.github/workflows/release.yml`).**
  Pushing a `v*.*.*` tag now compiles the Windows `.msi`, signs the updater artifacts with the keypair held in repo secrets, and publishes a draft GitHub release with the binaries + `latest.json` attached. The maintainer no longer needs to compile locally to ship a release. See `RELEASING.md` for the one-time signing-key setup.

### Fixed

- **`keyring` v3.6 feature rename.**
  The `linux-secret-service-rt-tokio-crypto-rust` feature was removed in keyring 3.6; replaced with the equivalent `sync-secret-service` + `crypto-rust` combination so `cargo check` (and the release workflow) build cleanly again.

## [0.2.1] — 2026-05-18

### Fixed

- **Keychain passwords lost between save and connect on Windows (and Linux/macOS).**
  `keyring = "3"` without explicit platform features resolves — depending on the minor
  version that Cargo picks — to a mock credential store where each `Entry` object is an
  independent in-memory container. `save_profile` writes to one `Entry` instance that is
  immediately dropped; the `connect` command creates a fresh `Entry` and finds nothing,
  producing the "no stored password for keychain account" error even though the profile
  was saved successfully and the dialog showed no error. Fixed by pinning
  `windows-native`, `apple-native`, and `linux-secret-service-rt-tokio-crypto-rust`
  features so the native OS credential store is always used regardless of which patch of
  keyring v3 resolves.

- **Dead-end error alert when keychain lookup fails on connect.**
  When `connect` failed because no keychain entry existed, the only UX was an `alert()`
  with no recovery path. A new `ConnectPasswordDialog` component now intercepts this
  specific error, lets the user enter the password inline, connects immediately with the
  in-memory credential, and writes it back to the keychain so subsequent connects work
  without prompting.

## [0.2.0] — 2026-05-17

First public alpha release. Bundles the full design overhaul, SSH tunnelling, disk-backed preferences and per-connection workspace, internationalisation, and the HeidiSQL-style data-grid affordances delivered across sessions 1 and 2.

### Added

- **HeidiSQL-style foreign-key combobox for inserts and cell edits.**
  When a column carries a single-column `FOREIGN KEY` constraint, the
  inline draft-row input (and the full-cell editor opened via
  double-click / `F11`) is replaced by a searchable dropdown of valid
  referenced values. Each entry is rendered as `<pk> — <label>`, with the
  label auto-picked server-side as the first non-PK text/varchar/char
  column on the target table — same affordance HeidiSQL has offered for
  years, brought to HuginnDB. Up to 200 rows are prefetched and filtered
  client-side; targets larger than that switch transparently to
  debounced server-side `ILIKE` search (`LIKE` on MySQL/SQLite) so the
  combobox stays responsive on tables with hundreds of thousands of
  rows. Nullable FK columns get a sticky `(NULL)` item at the top of the
  list; targets that are dropped or inaccessible degrade gracefully to a
  plain text input rather than blocking the edit. FK metadata is sourced
  from `pg_constraint` (Postgres), `information_schema.key_column_usage`
  (MySQL), and `PRAGMA foreign_key_list` (SQLite); composite FKs are
  ignored in this iteration and continue to render as plain inputs.
- **SSH host-key verification with TOFU (Trust On First Use)** for tunnelled
  connections. Each profile picks a policy: `accept-new` (default — trust
  on first connect, strict afterwards; mirrors `ssh -o StrictHostKeyChecking=accept-new`),
  `strict` (only accept fingerprints already in the store), or
  `accept-any` (skip verification — intended for throwaway test setups).
  Trusted SHA-256 fingerprints live in `known_hosts.json` next to `prefs.json`,
  keyed by `host:port` (same model as OpenSSH's `~/.ssh/known_hosts`), so
  multiple profiles pointing at the same SSH server share trust. The
  connection dialog shows the currently-trusted fingerprint and exposes a
  "Forget host key" button for the case where a server is legitimately
  reinstalled. Rejections surface a precise reason (mismatch vs. unknown)
  instead of `russh`'s generic transport error.
- **SSH tunnel support for PostgreSQL and MySQL connections**, HeidiSQL-style.
  The connection dialog gains an "SSH tunnel" tab that lets you enable a
  tunnel per profile and configure the SSH host, port, username, and either
  password or private-key authentication (with an optional passphrase and
  a file picker for the key). The local listener port can be set manually
  or left at `0` to auto-assign. SSH secrets live in the OS keychain under
  a namespaced account (`${profile.id}::ssh::${username}`) parallel to the
  DB password, never on disk. Backend uses `russh` 0.60 with the `ring`
  crypto backend (no `aws-lc-sys` build dependency); the tunnel is brought
  up before the `sqlx` pool, which is then pointed at `127.0.0.1:<local>`,
  and is torn down automatically when the connection is dropped. First-cut
  host-key verification is permissive; strict `known_hosts` enforcement is
  tracked as a follow-up.
- **Internationalisation (English + Spanish)** via `i18next` + `react-i18next`.
  Translations bundle in `src/lib/i18n/locales/{en,es}.json`. The active
  language is persisted in `prefs.json` (`ui.language`) so it survives
  restarts; switch from `Preferences → General → Language`. Migrated UI
  surfaces: top-bar tooltips and breadcrumb, File menu, View menu, status
  bar, the entire Preferences dialog, **the connection dialog, the
  connection sidebar / manage-connections dialog, and the schema explorer**
  (titles, fields, tooltips, confirm/alert prompts, test/save status
  messages). Remaining surfaces (table browser, query editor, error
  toasts) will migrate incrementally.
- **Central Preferences dialog** (Ctrl/Cmd+,) with sections for General,
  Editor, Data grid, Appearance, Shortcuts, and About. Replaces the
  themes-only Settings dialog while preserving its theme picker. Opened
  from the topbar gear icon, the View menu's "Preferences…" entry, or the
  keyboard shortcut. Changes apply live; no Save button.
- **Disk-backed user preferences** persisted to `prefs.json` in the
  platform config dir (`%APPDATA%\HuginnDB` on Windows, `$XDG_CONFIG_HOME`
  on Linux, `~/Library/Application Support` on macOS) alongside
  `profiles.json`. Tunable knobs include editor font/size/wrap/minimap,
  grid row height / page size / NULL display / zebra / sticky header /
  schema-tree metric, confirm-destructive prompts, and the query history
  cap. Loaded via the new `get_preferences` / `update_preferences` Tauri
  commands; the frontend debounces writes 400 ms to coalesce slider drags
  into single disk writes. The legacy `huginndb.viewPrefs.v1` localStorage
  blob is one-shot migrated into the new file on first launch and then
  cleared.
- **Per-connection workspace persistence**: open tabs (table + query,
  including draft SQL up to 64 KB), the active tab, and the schema-tree
  expansion are saved per profile to `tab_state.json`. Reconnecting a
  profile restores the workspace exactly as you left it; toggling
  "Restore tabs when opening a connection" off in General preferences
  opts out without losing the saved snapshot. Connections are LRU-pruned
  to the 20 most recent. Deleting a profile clears its workspace entry.
  Powered by the new `get_tab_state` / `save_tab_state` / `clear_tab_state`
  commands wired into a debounced subscription on `useTabs` and
  `useSchema.expanded`.
- **Window geometry remembered across launches** via
  `tauri-plugin-window-state` (size, position, maximised state). The
  plugin owns its own JSON sidecar in the app config dir.
- **Right-click context menu on data-grid cells**, modelled after HeidiSQL.
  Items: `Copy`, `Copy with column name` (renders as `col = 'value'` in the
  clipboard), `Set NULL` (PK-aware, only when the table is editable),
  `Filter by this value`, `Filter excluding this value`, plus row-level
  `Insert row…`, `Duplicate row…`, and `Delete row`. Built on a new
  `ContextMenu` wrapper (`src/components/ui/context-menu.tsx`) over
  `@radix-ui/react-context-menu`.
- **Server-side column filters with chip UI.** Right-clicking a cell can
  push a `ColumnFilter` onto the table tab; the filter survives pagination
  and refetches, and renders as a removable chip above the grid.
- **Server-side free-text search in the toolbar input.** The grid's
  "Filter rows…" box sends a `LIKE`/`ILIKE` match across every column,
  case-insensitively, so typed needles surface rows from any page —
  not just the one currently rendered. Submission is explicit: Enter
  commits, the clear (×) button applies an empty filter, and picking
  a history entry applies it immediately. Typing alone does not
  refetch. User input is escaped against LIKE metacharacters
  (`%`, `_`, `\`). AND-composed with the chip filters.
- **Filter history dropdown** next to the search input. Keeps an
  in-memory, per-connection list of recent searches (newest first,
  capped at 20, deduplicated) so the same needle can be re-applied to
  another table without retyping. Entries are only recorded when the
  user explicitly commits (Enter / dropdown pick), so the list stays
  meaningful rather than collecting every keystroke. Backed by a
  transient Zustand store (`useFilterHistory` in
  `src/stores/filterHistory.ts`) that is wiped when the connection is
  disconnected and discarded on app reload.

### Fixed

- **Search and chip filters no longer leak between table tabs.**
  `TabbedArea` now passes `key={activeTab.id}` to `TableDataTab` and
  `QueryEditorTab`, so switching between two table tabs unmounts and
  remounts the body. The previous behaviour reused a single React
  instance and dragged the search input, server filters, and any
  in-progress draft row across tabs.
- **`delete_rows` Tauri command** — `DELETE FROM <qt> WHERE <pk> IN (?, …)`
  with driver-appropriate placeholders (`$1, $2 …` for Postgres, `?` for
  MySQL/SQLite). Accepts a `Vec` of PK values so the same command will
  serve multi-row deletion when that lands.
- **`insert_row` Tauri command** — INSERTs from an ordered
  `Vec<RowValue>` of `{ column, value: Option<String> }` pairs, with
  `RETURNING <pk>` on Postgres when `pk_column` is supplied, and
  `last_insert_id` / `last_insert_rowid` on MySQL/SQLite. Backs both the
  Insert and Duplicate flows.
- **Inline draft row for Insert and Duplicate**, HeidiSQL-style.
  Choosing "Insert row…" or "Duplicate row…" pins a draft row to the
  top of the grid with a primary-tinted background. Each cell is a
  text input — Tab moves between fields, `Esc` cancels, and either
  pressing `Enter` or clicking outside the row commits the INSERT.
  Untouched cells are omitted from the statement so database defaults
  apply. Auto-increment primary keys (PK whose type contains
  `int` / `serial` / `rowid`) render as an `auto` placeholder. Nullable
  cells get an inline `∅` button to force an explicit `NULL`. If the
  backend rejects the INSERT, the draft survives with the typed values
  and shows the error inline so the user can correct and retry.
- **`filters` parameter on `fetch_table_data`** — an optional ordered
  list of `ColumnFilter { column, op, value }` where `op` is one of
  `eq`, `ne`, `is_null`, `is_not_null`. Identifiers are quoted via
  `quote_ident`; values are always sent as binds. The companion
  `SELECT COUNT(*)` also respects the filter so pagination footers stay
  accurate.
- **`Set NULL` action in `CellPreview`** — Ctrl+Shift+N or the new
  button writes `null` for the current cell when the panel was opened
  with a save handler.
- **Driver badges** in the connection list sidebar: each profile now shows a
  coloured pill (`PG` / `MY` / `SQL`) identifying its backend at a glance.
- **Approximate row counts** in the schema explorer tree, sourced without
  N+1 queries:
  - PostgreSQL: `pg_stat_user_tables.n_live_tup` (autovacuum-maintained).
  - MySQL: `information_schema.TABLES.TABLE_ROWS` (engine estimate).
  - SQLite: not shown — no reliable catalog source without per-table
    `COUNT(*)` queries.
- **`server_version` Tauri command** — queries the connected server for its
  version string (`"sqlite 3.45.3"`, `"postgresql 16.2"`, `"mysql 8.0.35"`)
  and caches it in the connections store after each successful connect.
- **Grouped schema tree**: tables and views are now separated into expandable
  `tables` / `views` / `indexes` sections within each schema node.
- **Editor info bar** at the bottom of the Monaco panel, showing the
  `Ctrl+Enter · Run` shortcut hint, the connected database name, live line
  and character count, and `sql · utf-8` encoding info.
- **Compact `CellPreview` panel**: single-clicking a grid cell now opens a
  floating panel anchored to the bottom-right of the data grid, showing the
  column name, detected content type (JSON / XML / SQL / TEXT), and a
  formatted preview. `F11` escalates to the full Monaco editor; `Esc` closes.
- **Numeric value colouring** in the data grid: columns with integer,
  float, decimal, real, or money types are rendered in amber (`text-amber-400`).
- **Row selection highlight**: clicking a row applies a blue tint; the last
  selected row is tracked as local state (not persisted).
- **Rich status bar**: now shows live query stats (row count + elapsed time),
  server encoding (`utf-8`), the connected server version, and the total
  number of entries in the query history ring buffer.
- **Header breadcrumb**: the title bar now shows `huginn · <db> · <driver>`
  when a connection is selected, or just `huginn` with the `alpha` badge when
  idle.
- **Tab bar polish**: active tab indicated by a bottom border (`border-primary`);
  close button hidden on inactive tabs and visible on hover; no `»` prefix on
  query tabs; default new query tab title is `query.sql`.
- `formatCount` and `isNumericType` pure utility functions added to
  `src/lib/utils.ts`, documented and reused across components.
- `lastQueryStats` field on `AppTab` + `updateQueryStats` action in the tabs
  store, used to propagate execution metadata from `QueryEditorTab` to the
  status bar.
- `versions: Record<string, string>` map in the connections store, populated
  on connect and cleared on disconnect.
- **File menu** in the top-left of the header — single dropdown surface
  for connection management. Lists every saved profile (click to connect,
  click again to select if already active), with `New connection…`,
  `Manage connections…` (opens the existing connection list in a modal),
  `Disconnect all`, and `Reset window layout` entries.
- **Drag-and-drop docking workspace** (powered by `dockview-react`) —
  the Schema, Saved, and Workspace (TabbedArea) panels can be dragged,
  resized, tabbed together, or split into rows / columns. The arrangement
  is persisted to `localStorage` under `huginndb.layout` and survives
  reloads; `Reset window layout` in the File menu wipes it back to the
  default (Schema + Saved tabbed on the left, Workspace on the right).
- New `useUi` Zustand store holding the `selectedConnectionId` so the
  three dockview panels can all read the same value without prop-drilling
  through the dockview boundary.

### Changed

- **Dockview now follows the active app theme.** The built-in `themeAbyss`
  / `themeLight` were swapped for a custom theme whose `--dv-*` CSS
  variables resolve to our shadcn-style tokens (`--background`,
  `--foreground`, `--border`, `--primary`, …). This means tab strips,
  resize sashes, drop overlays, floating panels, and context menus all
  inherit whichever theme the user has selected in the Settings dialog —
  no more visual mismatch when switching between custom themes.
- **More discoverable panel drag-and-drop.** Tabs now show a `grab` /
  `grabbing` cursor, and the drag-over overlay uses a primary-tinted
  background with a dashed 2 px border so the drop targets are easy to
  see. `dndPanelOverlay: 'group'` makes the overlay cover the full panel
  group instead of just the content area.

- **Connections sidebar removed.** The persistent `ConnectionList` panel
  in the sidebar is gone — its functionality moved into the File menu
  and the new `ManageConnectionsDialog`. This frees up vertical space
  for the Schema explorer once the user has finished configuring their
  profiles.
- **Rename: Huginn → HuginnDB.** Product name, Cargo package, Tauri
  productName / identifier (`io.huginndb.app`), keychain service, on-disk
  config directory (`%APPDATA%\HuginnDB\…`), localStorage keys
  (`huginndb.theme.v2`, `huginndb.queryHistory`, `huginndb.savedQueries`),
  built-in theme names (`HuginnDB Dark / Light`), and all public docs.
  The GitHub repository was subsequently renamed from `huggin` to
  `huginnDB` to match.

### Migration notes for alpha users

- Saved connection profiles will not be found on first launch after this
  update because the config directory moved from `%APPDATA%\Huginn\` to
  `%APPDATA%\HuginnDB\`. Recreate them through the File menu, or copy
  `profiles.json` across by hand. Stored passwords in the OS keychain
  remain under their original service id, so they will need to be
  re-saved as well (the keychain service id is now `io.huginndb.app`).
- The persisted theme will be reset because the localStorage key
  changed; pick your theme again from the Settings dialog.

## [0.1.0-alpha] — 2026-05-13

Initial alpha. Not yet tagged; this snapshot represents the work
delivered during the first design session.

### Added

- Tauri 2 desktop shell for Windows and Linux with a React + TypeScript
  frontend.
- Connection manager for PostgreSQL, MySQL, and SQLite, with password
  storage in the OS keychain (Windows Credential Manager / libsecret /
  macOS Keychain).
- Schema explorer: databases → tables/views → columns (with type badges
  and primary-key indicator) plus indexes.
- Paginated, sortable, filterable table data browser built on TanStack
  Table with inline cell editing.
- Expanded cell editor — Monaco-based dialog with JSON/XML/SQL detection,
  format/beautify, live JSON validation, and an `F11` fullscreen toggle.
- SQL query editor — Monaco-based, self-hosted (no CDN dependency), with
  schema-aware autocomplete, `Ctrl+Enter` to run, and a persisted query
  history sidebar (last 50 entries, per-connection filter).
- Saved queries library with name, description, tags, and "open in new
  query tab" action. Persisted to localStorage.
- Themes — five built-in presets (HuginnDB Dark, HuginnDB Light, Dim,
  Solarized Dark, High Contrast) plus a visual colour editor that
  auto-forks built-ins into custom themes on first edit.
- Resizable horizontal and vertical panels for sidebar width and
  editor/results split.

### Known limitations

- SSH tunnel configuration is captured in the UI but is not yet wired up
  in the Rust backend.
- Only Windows `.msi` and Linux `.deb` / `.AppImage` bundle outputs are
  configured.
- No automated tests.
