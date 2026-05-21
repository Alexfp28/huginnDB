# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

## [0.7.1] — 2026-05-21

Patch de imagen corporativa. Reemplaza el icono placeholder de la "H"
verde por el nuevo logotipo oficial de HuginnDB (ojo nórdico sobre fondo
oscuro, estilo app-icon con rounded corners). Sin cambios funcionales.

### Changed

- **Nuevo logotipo oficial.** Todos los iconos de la aplicación
  (`src-tauri/icons/`) han sido regenerados desde la nueva fuente
  `huginn-app-icon-512.png` usando `pnpm tauri icon`. El logo anterior
  (letra "H" con círculo verde) queda reemplazado en todas las
  plataformas: Windows (`.ico`, APPX squares, Store Logo), macOS
  (`.icns`), Linux (PNGs), iOS y Android.

- **Assets de imagen corporativa añadidos.** `public/image/` incluye
  ahora las variantes oficiales del logotipo: `huginn-app-icon` en
  1024/512/256/128/64 px, más las variantes SVG del mark
  (`huginn-mark`, `huginn-mark-black`, `huginn-mark-white`,
  `huginn-mark-blue`, `huginn-mark-runes`) para uso en web, docs y
  marketing.

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
  while the filter is active; databases that match by *name* are
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
  `<profile.id>::ssh::<ssh_user>` *before* `smoke_test`, matching the
  UX already in place for the DB password. To keep the keychain
  account stable between Test and Save for brand-new profiles, the
  connection dialog pre-mints a UUID on open via `crypto.randomUUID()`
  and threads it through `buildProfile()`; `save_profile` already
  treated a supplied id as authoritative, so this is a no-op there.

### Fixed

- **Duplicate database node in multi-DB MySQL / SQLite explorers.**
  Expanding a database in multi-DB mode used to render *the same
  database name* a second time with a Database icon underneath,
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
  with `try_get` (returns `Result` instead of panicking) plus a signed/unsigned
  fallback chain so the schema loads correctly on MySQL 5.7, 8.0, MariaDB, and
  any fork regardless of how type flags are reported. The current database is
  resolved via `SELECT DATABASE()` so the implementation no longer depends on
  `information_schema` at all for MySQL table listing.

## [0.3.2] — 2026-05-18

### Fixed

- **MySQL schema loading broken by two additional bugs.**

  1. *Infinite refresh loop.* The `SchemaExplorer` effect condition
     `!cs || !cs.initialized` fired on every state update while a fetch was
     in flight (`loading: true` creates a new object reference each time
     Zustand updates), launching a new concurrent `list_tables` call on every
     tick. MySQL's `information_schema.tables` is slow, so the pool was
     saturated by looping queries that never completed. Fixed by adding
     `!cs.loading` to the guard so the effect is a no-op while a fetch is
     already running. `initialized: true` is now also set in the error path so
     a failed fetch does not trigger the same loop.

  2. *`size_bytes` type mismatch on MySQL.* The expression
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
