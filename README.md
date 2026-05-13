# Huginn

A minimal, fast, cross-platform desktop database manager — inspired by HeidiSQL, built with **Tauri**, **React + TypeScript**, **Tailwind + shadcn/ui**, **TanStack Table**, and **Monaco**. Supports **PostgreSQL**, **MySQL**, and **SQLite**.

## Features

- Connection manager for PostgreSQL, MySQL, and SQLite — credentials stored in the OS keychain (Windows Credential Manager / libsecret).
- Schema explorer: databases → tables/views → columns with type badges + PK indicator, plus indexes.
- Paginated, sortable, filterable table data browser (TanStack Table) with inline editing.
- **Expanded cell editor (star feature)**: any cell can be popped open into a full Monaco editor with auto-detected JSON / XML / SQL / plain-text highlighting, validation, and format/beautify.
- SQL query editor (Monaco) with schema-aware autocomplete, Ctrl+Enter to run, query history (last 50), and a dedicated results grid.
- Tabbed workspace with resizable sidebar + horizontal / vertical resizable panels.
- Dark mode by default, light mode toggle, persisted to local storage.
- Status bar with connection state, current tab, and version.

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`)
- **Rust** stable toolchain — install via [rustup](https://rustup.rs)
- Platform-specific Tauri prerequisites:
  - **Windows**: WebView2 (preinstalled on Windows 11) + Microsoft Visual Studio Build Tools with the *Desktop development with C++* workload.
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, and `libsecret-1-dev` (for the keychain).

See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the most up-to-date list.

## Install

```bash
pnpm install
```

> **Always use pnpm.** Do not use `npm` or `yarn`.

## Run in development

```bash
pnpm tauri:dev
```

This compiles the Rust backend, starts Vite on `http://localhost:1420`, and opens the Tauri shell.

## Build for production

```bash
pnpm tauri:build
```

Produces installers under `src-tauri/target/release/bundle/`:

- **Windows**: `.msi` installer
- **Linux**: `.AppImage` and `.deb`

## Project layout

```
huggin/
├─ src/                       # React + TypeScript frontend
│  ├─ components/             # UI + feature components (shadcn + features)
│  ├─ stores/                 # Zustand stores (connections, schema, tabs, history, theme)
│  ├─ lib/                    # Tauri command wrappers + helpers
│  ├─ types.ts                # Shared TS types
│  └─ App.tsx, main.tsx
└─ src-tauri/                 # Rust backend
   ├─ src/
   │  ├─ commands/            # Tauri command handlers (connection, query, schema, credentials)
   │  ├─ state.rs             # Active pools + connection profiles
   │  ├─ store.rs             # Persisted profiles on disk (no passwords)
   │  ├─ error.rs             # AppError type, serialized to the frontend
   │  └─ lib.rs, main.rs
   ├─ capabilities/default.json
   ├─ tauri.conf.json
   └─ Cargo.toml
```

## Security

- All database I/O happens in the Rust backend. The frontend only talks to Tauri commands — it never opens DB connections directly.
- Passwords are never written to disk. They are stored in the OS keychain via the [`keyring`](https://crates.io/crates/keyring) crate (Windows Credential Manager / libsecret).
- Connection profile metadata (host, port, database, username, SSL, driver) is stored in your platform config directory (e.g. `%APPDATA%\Huginn\profiles.json` on Windows).

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Run SQL query | `Ctrl+Enter` |
| Expand cell in editor | Double-click cell, or click the maximize icon |
| Toggle theme | Top-right sun/moon icon |

## Roadmap (post-MVP)

- SSH tunnel implementation
- More database drivers (MS SQL, ClickHouse)
- Bulk row insert / delete
- Schema diff & export
- Table structure editor

## License

MIT
