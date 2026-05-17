<div align="center">

# HuginnDB

**A fast, keyboard-friendly desktop database manager.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://v2.tauri.app)
[![Made with Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org)
[![Frontend: React + TS](https://img.shields.io/badge/React-TypeScript-3178c6?logo=typescript)](https://www.typescriptlang.org)

HuginnDB is a cross-platform desktop client for **PostgreSQL**, **MySQL**, and **SQLite**. It pairs a minimalist UI with a first-class cell editor and a Monaco-powered SQL workspace — the goal is to make routine database work feel as fluid as your text editor.

</div>

---

## Table of contents

- [Why HuginnDB?](#why-huginn)
- [Features](#features)
- [Status](#status)
- [Screenshots](#screenshots)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [From source](#from-source)
- [Usage](#usage)
  - [Connecting to a sample database](#connecting-to-a-sample-database)
  - [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Why HuginnDB?

Most database GUIs are either heavyweight Java IDEs or web-based dashboards that fight you the moment you need to inspect a 50&nbsp;KB JSON blob inside a column. HuginnDB picks a narrower scope:

- **Inspecting and editing data is the primary job.** Every cell can be opened in a full Monaco editor with auto-detected syntax highlighting and validation.
- **The SQL editor is a real editor.** Same component, same shortcuts, schema-aware autocomplete, query history.
- **Keyboard-first, minimal chrome.** Dark mode by default, no nested toolbars, no popup soup.
- **Credentials never touch disk in plaintext.** Passwords go to the OS keychain.

It's named after [Huginn](https://en.wikipedia.org/wiki/Huginn_and_Muninn), one of Odin's ravens — the one who fetches information.

## Features

- **Multi-driver connection manager.** PostgreSQL, MySQL, and SQLite, each with a per-driver dialog and the right defaults.
- **Schema explorer.** Tree of databases → tables/views → columns (with type badges and primary-key indicators) and indexes.
- **Data browser.** Paginated, sortable, filterable grid built on [TanStack Table](https://tanstack.com/table). Inline cell edits are routed through the backend with PK-based safety.
- **Expanded cell editor.** Pop any cell into a Monaco editor with auto-detected JSON / XML / SQL highlighting, format/beautify, live JSON validation, and an `F11` fullscreen toggle.
- **SQL workspace.** Monaco-based, self-hosted (no CDN dependency), with schema-aware autocomplete, `Ctrl+Enter` to run, and a per-connection history sidebar that survives restarts.
- **Saved queries.** A local library with name, description, and tags. Open any entry into a fresh query tab.
- **Themes.** Five built-in presets (HuginnDB Dark, HuginnDB Light, Dim, Solarized Dark, High Contrast) plus a visual colour editor. Editing a preset forks it into a new custom theme so the originals stay pristine.
- **Resizable layout.** Both horizontal (sidebar) and vertical (editor / results) splits are draggable.

## Status

**Alpha.** The MVP is feature-complete for read/write workflows against the supported drivers, but the project hasn't been hardened by real-world use yet. Expect rough edges, occasional sharp corners around exotic column types, and a roadmap that still has open questions ([Roadmap](#roadmap)).

## Screenshots

> **Note:** Screenshots will be added once the UI stabilises. In the meantime, the [Features](#features) list and [Usage](#usage) section describe the workflow.

## Installation

### Prerequisites

| Tool                     | Why                                              | Install                                                                   |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| **Node.js ≥ 20**         | Vite, TypeScript, frontend tooling.              | [nodejs.org](https://nodejs.org) or [`fnm`](https://github.com/Schniz/fnm) |
| **pnpm ≥ 10**            | The only supported package manager.              | `npm i -g pnpm`                                                           |
| **Rust (stable)**        | Compiles the Tauri backend.                       | [rustup.rs](https://rustup.rs)                                            |
| **Platform Tauri prereqs** | Native build deps (compiler, webview, etc.). | See platform-specific list below.                                          |

> **Always use pnpm.** Do not invoke `npm` or `yarn` against this repository — the lockfile is pnpm-only.

#### Windows

1. **Visual Studio Build Tools 2022** with the *Desktop development with C++* workload.
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait"
   ```
2. **WebView2** is preinstalled on Windows 11. On Windows 10, install the [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/).

#### Linux

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev libsecret-1-dev
```

Equivalent packages exist on Fedora, Arch, and Alpine — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the per-distro names.

#### macOS

```bash
xcode-select --install
```

macOS is not a primary target yet but the build should work — please file an issue if you hit something.

### From source

```bash
git clone https://github.com/Alexfp28/huginnDB.git
cd huginnDB
pnpm install
pnpm tauri:dev          # dev mode with HMR
# or
pnpm tauri:build        # release bundle in src-tauri/target/release/bundle/
```

The first `tauri:dev` is slow — Cargo compiles `sqlx` with three database drivers plus `keyring`, `tokio`, and friends. Plan for **5–10 minutes** on a typical laptop. Incremental rebuilds afterwards take well under 10 seconds.

Release bundles land under `src-tauri/target/release/bundle/`:

- **Windows** — `.msi` installer.
- **Linux** — `.deb` and `.AppImage`.

## Usage

### Connecting to a sample database

The fastest way to play with HuginnDB is the [Chinook](https://github.com/lerocha/chinook-database) sample database in SQLite — a single file you can point HuginnDB at:

```bash
mkdir -p sample-data
curl -L -o sample-data/chinook.db \
  https://github.com/lerocha/chinook-database/raw/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite
```

Then in HuginnDB:

1. Click the **+** in the **Connections** panel.
2. Pick **SQLite** as the driver.
3. Paste the absolute path to `chinook.db` into **Database file path**.
4. Test → Save → Connect.

Tables like `Album`, `Artist`, and `Invoice` should appear in the schema explorer. Try this query in a new query tab:

```sql
SELECT ar.Name AS artist,
       COUNT(*) AS albums
FROM Artist ar
JOIN Album al ON al.ArtistId = ar.ArtistId
GROUP BY ar.ArtistId
ORDER BY albums DESC
LIMIT 10;
```

### Keyboard shortcuts

| Action                          | Shortcut       |
| ------------------------------- | -------------- |
| Run the current query           | `Ctrl+Enter`   |
| Expand the focused cell         | Double-click   |
| Fullscreen the cell editor      | `F11`          |
| Exit fullscreen / close editor  | `Esc`          |
| Toggle light/dark mode          | Sun/moon icon  |
| Open settings & theme editor    | Gear icon      |

## Architecture

HuginnDB is split into two cooperating processes:

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│      Tauri webview          │         │       Rust backend           │
│  React + TypeScript + Vite  │  invoke │  tauri::command handlers     │
│  Zustand stores             │ <─────> │  sqlx (PG / MySQL / SQLite)  │
│  TanStack Table + Monaco    │   IPC   │  keyring (OS keychain)       │
└─────────────────────────────┘         └──────────────────────────────┘
```

- The **frontend** never opens a database connection. It calls `api.*` (a thin typed wrapper around Tauri's `invoke`) and renders whatever the backend returns.
- The **backend** owns all live `sqlx` pools and resolves passwords against the OS keychain at the moment of use. Connection strings are never exposed to the webview.

For a deeper map of the code layout, read [`CONTRIBUTING.md`](CONTRIBUTING.md#project-layout). The two starter files are:

- `src-tauri/src/lib.rs` — Rust entry point and command registry.
- `src/App.tsx` — top-level React layout.

### Tech stack

- **Shell**: [Tauri 2](https://v2.tauri.app) (Rust + WebView).
- **Frontend**: React 18, TypeScript (strict), Vite, Tailwind CSS, [shadcn-style](https://ui.shadcn.com) Radix primitives.
- **State**: [Zustand](https://github.com/pmndrs/zustand) with `persist` middleware for theme, history, and saved queries.
- **Data grid**: [TanStack Table v8](https://tanstack.com/table).
- **Editor**: [Monaco](https://microsoft.github.io/monaco-editor/) (self-hosted; no CDN).
- **Backend**: Rust, [sqlx](https://github.com/launchbadge/sqlx) (PostgreSQL, MySQL, SQLite), [keyring](https://crates.io/crates/keyring), [tokio](https://tokio.rs), [thiserror](https://crates.io/crates/thiserror).
- **Bundling**: Tauri bundler — `.msi` (Windows), `.deb` / `.AppImage` (Linux).

## Security model

HuginnDB is a single-user desktop tool. The threat model is primarily a curious local user or a hostile database operator, not a remote attacker reaching the user's machine.

- **Credentials**: stored in the OS keychain (Windows Credential Manager, libsecret on Linux, Keychain on macOS) via the [`keyring`](https://crates.io/crates/keyring) crate. The on-disk profile JSON contains only metadata (host, port, db, username, SSL toggle).
- **Database I/O isolation**: all `sqlx` access lives in the Rust process. The frontend cannot reach a database directly.
- **No telemetry**: the binary does not phone home.
- **CSP**: currently disabled (`csp: null`) because Monaco needs to load its workers. Workers are bundled by Vite — not loaded from a CDN — so the relaxation is narrowly scoped. Tightening this is on the roadmap.
- **Identifier quoting** in dynamic SQL is intended for catalog-sourced identifiers; user-supplied data always travels through bound parameters.

If you find a vulnerability, please follow [SECURITY.md](SECURITY.md).

## Roadmap

Roughly ordered by priority.

- **SSH tunnel support** — the UI fields exist; the backend implementation is the next major feature.
- **Bulk row insert / delete** in the data browser.
- **Schema diff and export** (DDL extraction, side-by-side compare).
- **More drivers** — Microsoft SQL Server, ClickHouse, DuckDB.
- **Table structure editor** — visual ALTER TABLE.
- **Tighter CSP** for the webview.
- **Automated tests** — integration tests against ephemeral Postgres/MySQL containers, frontend interaction tests with Playwright.
- **macOS bundle** with code signing.
- **Visual query builder** (low-priority — the SQL editor is fast enough that most users probably don't want a builder).

Have a different priority? Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.md).

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers the project layout, commit conventions, coding standards per language, and a recipe for adding a new database driver.

Newcomer-friendly issues are labelled `good first issue`.

## License

[MIT](LICENSE). Use it, fork it, ship products with it.

## Acknowledgements

HuginnDB stands on the shoulders of giants:

- [Tauri](https://v2.tauri.app) for the desktop runtime.
- [sqlx](https://github.com/launchbadge/sqlx) for the async, type-safe SQL toolkit.
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — VS Code's brain transplanted into a browser pane.
- [TanStack Table](https://tanstack.com/table) for the data grid.
- [shadcn/ui](https://ui.shadcn.com) for the design vocabulary and Radix primitive recipes.
- [HeidiSQL](https://www.heidisql.com) and [DBeaver](https://dbeaver.io) — for showing what a great database client can look like.
- The [Chinook](https://github.com/lerocha/chinook-database) sample database for making "try HuginnDB in 60 seconds" possible.
