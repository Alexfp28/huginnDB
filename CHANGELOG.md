# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

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
