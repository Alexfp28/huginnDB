# CLAUDE.md

Project context for Claude Code sessions on this repo. Skim this first; reach for `README.md` / `CONTRIBUTING.md` / `SECURITY.md` for the public-facing detail.

## Identity

- **HuginnDB** — desktop database manager, Tauri 2 (Rust backend) + React + TypeScript frontend.
- Targets PostgreSQL, MySQL, SQLite, **MongoDB**, and **Microsoft SQL Server**. Inspired by HeidiSQL but minimal-UI / keyboard-first / Monaco-everywhere.
- Public repo: <https://github.com/Alexfp28/huginnDB>.
- License: MIT. Status: **1.20.x** (stable; SemVer applies). MongoDB support landed in 1.1.0; the headless MCP connector (`huginndb-mcp`) landed across the 1.5–1.9 line (per-connection write policy in 1.9.0); HuginnDB Pulse (live server health/performance monitoring, MySQL + MongoDB) landed in 1.20.0.

## Maintainer / collaboration notes

- Sole maintainer: **Alexfp28** (`alexlopezdelafuente@gmail.com`). Security contact: `contact@shion.es`.
- User communicates in **Spanish**; reply in Spanish. Code, comments, commit messages, and docs are **English**.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, …) with **long-form bodies** explaining the *why*. The user explicitly values verbose commits — never punt with a one-liner on non-trivial changes.
- Keep `CHANGELOG.md` in sync (Keep a Changelog format). Add to `Unreleased` as you go; the user will cut releases manually.

## Tech stack quick reference

| Layer       | Choice                                                   |
| ----------- | -------------------------------------------------------- |
| Shell       | Tauri 2 (`@tauri-apps/cli`, `@tauri-apps/api`)           |
| Frontend    | React 18 + TS strict, Vite                               |
| Styling     | Tailwind CSS + shadcn-style Radix primitives             |
| State       | Zustand (with `persist` for theme / history / saved)     |
| Data grid   | TanStack Table v8                                        |
| Editor      | Monaco — **self-hosted, no CDN** (`src/lib/monaco/monaco-setup.ts`) |
| DB drivers  | `sqlx` 0.8 (`postgres`, `mysql`, `sqlite`) + `mongodb` 3 (`bson-3`) + `tiberius` 0.12 (SQL Server; `sqlx` has no MSSQL driver) |
| Credentials | `keyring` crate (Windows Credential Manager / libsecret) |
| Package mgr | **pnpm only**. Never suggest `npm` or `yarn`.            |

## Repo map (compressed; see `CONTRIBUTING.md` for the full version)

```
src/                       frontend
  components/              feature components, grouped by domain (each domain gets an optional
                           dialogs/ subfolder for its modal-only components — see gotcha #28)
    ui/                    shadcn primitives
    common/, connection/, schema/, query/, grid/, menus/, shell/, settings/,
                           aggregation/, indexes/, jsonSchema/
                           (a tree/grid is one file per level: SchemaExplorer →
                           Single/MultiDbExplorer → SchemaTableSection →
                           SchemaTableRow; DataGrid → GridToolbar + GridRow,
                           with its hooks under lib/grid/)
  stores/                  Zustand stores, themselves grouped:
    session/               connections, tabs, schema, environments, ui, treeSearch,
                           persistedTabs
    preferences/, dialogs/, grid/, query/, sync/   (+ jsonSchemas.ts, update.ts)
  lib/                     tauri wrapper, themes, constants, pure helpers; grouped:
    monaco/, bridges/, db/, grid/, sql/, schema/, tabs/, transfer/, mongo/,
                           (schema/ owns the tree filter's pure core: matchesFilter,
                           filterScope, treeMatches + useTreeMatchCounts, and the
                           one warm scheduler — gotcha #55)
    commandPalette/, connection/, jsonSchema/, appInfo/, i18n/, keybindings/
                           (keybindings/ is catalogue + key lexicon + resolver +
                           one dispatcher — see gotcha #53)
                           (appInfo/ holds the docs registry and docOutline, which
                           derives the viewer's section tree from the markdown itself)
  types.ts                 shared TS types mirroring Rust DTOs

src-tauri/src/             backend (workspace root; see mcp-server/ below)
  commands/                Tauri command handlers (the public API)
  db/                      pool / sql / classify / values helpers (driver-agnostic;
                           classify.rs owns the one write-tier decision — gotcha #54)
  keychain.rs              centralised keyring access
  state.rs, store.rs       state + disk persistence (profiles)
  prefs.rs                 user preferences → prefs.json
  tab_state.rs             per-connection tab state → tab_state.json
  error.rs                 AppError / AppResult
  mcp/                     MCP connector logic (behind the `mcp` feature)

src-tauri/mcp-server/     sibling crate: the `huginndb-mcp` binary shim
                           (kept out of the app's own Cargo.toml — gotcha #20)
```

Two starter files for new contributors: `src-tauri/src/lib.rs` and `src/App.tsx`.

## Hard-earned gotchas

Documentados como ADRs individuales en [`adr/`](adr/README.md) — uno por gotcha, con resumen y fecha en la cabecera de cada archivo. Antes de tocar código en un área con historial (Zustand, Monaco, tab_state, MySQL/MongoDB decoding, dockview, environments, MCP, etc.), consulta el índice y lee el ADR relevante completo — no asumas que el resumen de una línea basta.

Deliberadamente fuera de `docs/`: son documentación interna para agentes de IA y contribuidores, no para el visor de Documentación de la app (ver [gotcha #50](adr/gotcha-050-docs-viewer-markdown-derived-navigation.md)).

## Workflow

```powershell
# dev (Tauri shell + Vite HMR)
pnpm tauri:dev

# production bundle (Windows .msi / Linux .deb / .AppImage)
pnpm tauri:build

# quick reality check (downloads the Chinook SQLite sample, ~1 MB)
mkdir -p sample-data
curl -L -o sample-data/chinook.db `
  https://github.com/lerocha/chinook-database/raw/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite
# then in HuginnDB: + connection → SQLite → path to chinook.db
```

`sample-data/` is gitignored on purpose — don't commit fixtures.

First build is **slow** (5–10 min) because Cargo compiles all three `sqlx` drivers + `keyring` + `tokio` from scratch. Incremental rebuilds are <10 s.

The Rust toolchain + MSVC Build Tools (Windows) are prerequisites; the user already has both. Tauri's per-platform deps are in the README.

## Architecture invariants

- The **frontend never talks to a database directly.** All DB I/O lives in Rust commands. The frontend uses the typed wrapper at `src/lib/tauri.ts` — do not call `invoke` from components.
- **Passwords never hit disk in plaintext.** `keyring` is the only persistence path. Profile metadata (host, port, db, username, SSL toggle, driver) lives in JSON inside the platform config dir; the password is keyed by `${profile.id}::${username}` in the OS keychain.
- **CSP is `null` on purpose** because Monaco loads its workers as blobs. Workers themselves are bundled (no remote fetch), so the relaxation is narrow. Tightening CSP is on the roadmap.

## On-disk state map (platform config dir)

| File                    | Owner                              | Notes |
| ----------------------- | ---------------------------------- | ----- |
| `profiles.json`         | `src-tauri/src/store.rs`           | Connection metadata only. Passwords in OS keychain. Loading a file that exists but won't parse is a hard error on purpose (unlike every other file here) — silently substituting an empty list would show the user an app that has lost every saved connection, and the next save would make that true on disk. |
| `prefs.json`            | `src-tauri/src/prefs.rs`           | User preferences (editor / grid / ui). Atomic temp-file + rename on write. Bad JSON falls back to `Preferences::default()` — never blocks startup. |
| `tab_state.json`        | `src-tauri/src/tab_state.rs`       | **v5** — `{ version, environments[], activeEnvironmentId, origins }`; each environment owns its `connections` map (LRU-pruned to 20 *per environment*; query bodies capped at 64 KB), its dockview geometry and its `launch` state, while `origins` is a **global** registry (gotcha #40) whose entries also carry this machine's `role` for that file (`consumer` by default — gotcha #56) and the last-seen `maintainer`. Written only by the main window (see gotchas #8 and #27). v1–v4 blobs migrate: v1/v2/v3 fold into one unnamed environment (v2 "workspaces" still lose all but the active one), and v4's per-environment origins are hoisted and deduped by path. |
| `json_schemas.json`     | `src-tauri/src/json_schemas/`      | User JSON Schema library + per-column bindings. **Global**, not per environment, and never pruned (see gotcha #39). Atomic temp-file + rename; bad JSON falls back to an empty library rather than blocking startup. Bodies are stored as source text and the backend never parses them. |
| `*.window-state.json`   | `tauri-plugin-window-state` v2     | Plugin-owned; do not parse manually. Removes need for a hand-rolled `window.rs`. |
| `pulse.db`              | `src-tauri/src/pulse/store.rs`     | **The one file here that is not JSON.** Pulse's on-disk history — a SQLite database (WAL, single `samples(connection_id, ts_ms, metric, value)` table), appended to by `pulse::sampler`'s 60 s tick rather than rewritten whole like every file above it; `state_file::save_atomic`'s whole-blob-atomic-rename pattern is exactly the write amplification a time series needs to avoid. `state_file::path("pulse.db")` still resolves *where* it lives — that function only resolves a path and creates the parent directory, it never assumes JSON — so canary isolation (gotcha #26) applies here for free. Opened lazily (first sampler tick or first Retrospectiva read), so an install where nobody has enabled Pulse on any connection never creates the file. Retention is a staircase: 60 s resolution for 48 h, downsampled to one point per 5 min out to `PulsePrefs::retention_days` (30 by default), then deleted; a `maxDiskMb` soft cap sheds the oldest tenth of what remains if the file is still over budget after that. Sampling itself is opt-in per connection (`ConnectionProfile::pulse_enabled`, off by default, preserved across a shared-origin sync the same way `mcp_write` is) and reads only what `pulse::sampler` needs in one round trip — `db::mysql::pulse::sample`/`db::mongo::pulse::sample`, not the two-round-trip `health()` the live panel uses. |

Theme + dockview layout still live in `localStorage` (keys `huginndb.theme.v2` and `huginndb.layout`) — synchronous read pre-mount avoids FOUC. Don't migrate these to disk without a plan for the flash.

## Current status (post-session 3)

- Released 0.5.0: workspace switcher with reorder/colour/icon, "Copy row as ▸ JSON/INSERT/UPDATE" submenu, connection-level filter in multi-DB explorer, and the fix for the cell-save row-mismatch bug under client filters.
- Released 0.6.0 right after: Ctrl+Enter restored, per-statement "▶ Run" CodeLens, driver-aware keywords in the autocomplete (Postgres `RETURNING`, MySQL `ON DUPLICATE KEY UPDATE`, …) with tables-first sort.
- Backend has ~300 `cargo test`s (tab-state migrations and prune semantics included). The frontend has Vitest (`pnpm test`) covering the pure `lib/` modules and the extracted hooks — characterization tests written alongside each refactor, not a blanket suite. CI (`.github/workflows/ci.yml`) runs typecheck + Vitest + `cargo fmt`/`clippy`/`test` on Linux and Windows.
- Released 1.4.0: removed workspaces in favour of native per-window instances — "New window" in the new **Window** menu opens a blank, ephemeral secondary window; see gotcha #8 and the `CHANGELOG.md` 1.4.0 entry. Same cycle also split the topbar File/View menus into four (File/Window/View/Help — File had accumulated unrelated window/help actions), fixed two bugs (`open_new_window` must be an `async fn` on Windows — sync commands deadlock creating a `WebviewWindow`, a WebView2 issue — and CLI ad-hoc launches without `--password` now always attempt the connect instead of silently staying disconnected), added server-side users/permissions introspection (a "Security" panel, implemented for every driver including SQLite's explicit no-user-model empty state — `commands::schema::list_users`/`list_privileges`), and added a background connection keepalive + lost-connection reconnect UX (`src-tauri/src/keepalive.rs` — a 3-minute heartbeat per top-level connection; a failed ping flags the connection in `stores/session/connectionHealth.ts` and both `ConnectionList`/`StatusConnections` offer a one-click reconnect instead of the user hitting a cryptic driver error mid-query).
- macOS is not a primary target; build should work but unverified.

## Roadmap

`ROADMAP.md` (repo root) is the single source of truth for what's shipped and
what's open — don't duplicate its list here, it will drift. Detail-level
roadmaps for two subsystems are tracked separately and still current:
`docs/MONGODB_ROADMAP.md` and `docs/MCP_CONNECTOR_ROADMAP.md`.

## Explicitly out of scope (don't propose unless asked)

- Adding a linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy` advice in CONTRIBUTING.
- AI features (autocomplete suggestions via LLM, "explain this query", etc.).
- Cloud sync of profiles or saved queries.
- Mobile builds — the Tauri icon CLI generated iOS/Android directories during scaffolding, but desktop is the focus.

## When the user asks for "the next thing"

- Default to the **top open item in `ROADMAP.md`'s numbered "Open" list** unless
  they say otherwise.
- **`ROADMAP.md` has a second list: "Fit and finish".** It is a standing track,
  not a backlog that waits for the numbered one to empty, and the convention is
  that **each minor release closes at least two of its entries**. Check it when
  planning a release, not only when asked for "the next thing" — the reason it
  exists is that polish was never in the queue at all, so the queue could never
  produce one. Entries name something observable (a file and line, a count, a
  behaviour) and fall into one of four classes; the adoption-debt class is
  machine-counted by `src/components/ui/uiAdoption.test.ts`, whose budgets are
  sorted by debt and double as its worklist.
- Always ask before adding new dependencies; the user prefers a small, audited tree.
- Keep PRs / commits scoped. The user values legible history and will read the long-form commit body.

## Communication style

- Replies in Spanish, terse, no fluff. The user reads diffs and runs commands themselves; they don't need a walkthrough.
- One sentence before a tool batch is enough.
- End-of-turn summary: ≤ 2 sentences. What landed, what's next.
- When proposing a non-trivial change, ask 1–2 scoping questions with `AskUserQuestion` rather than guessing.
