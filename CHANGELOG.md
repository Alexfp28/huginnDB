# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

### Added

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
  The GitHub repo slug remains `huggin` (original typo) and is
  unchanged.

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
