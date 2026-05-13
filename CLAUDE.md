# CLAUDE.md

Project context for Claude Code sessions on this repo. Skim this first; reach for `README.md` / `CONTRIBUTING.md` / `SECURITY.md` for the public-facing detail.

## Identity

- **Huginn** — desktop database manager, Tauri 2 (Rust backend) + React + TypeScript frontend.
- Targets PostgreSQL, MySQL, SQLite. Inspired by HeidiSQL but minimal-UI / keyboard-first / Monaco-everywhere.
- Public repo: <https://github.com/Alexfp28/huggin> (repo slug is `huggin` — typo carried over from the local folder name; the *product* is "Huginn").
- License: MIT. Status: **alpha**, just published.

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
| Editor      | Monaco — **self-hosted, no CDN** (`src/lib/monaco-setup.ts`) |
| DB drivers  | `sqlx` 0.8 with `postgres`, `mysql`, `sqlite` features   |
| Credentials | `keyring` crate (Windows Credential Manager / libsecret) |
| Package mgr | **pnpm only**. Never suggest `npm` or `yarn`.            |

## Repo map (compressed; see `CONTRIBUTING.md` for the full version)

```
src/                       frontend
  components/              feature components (flat, ~13 files)
    ui/                    shadcn primitives
  stores/                  Zustand stores (one per domain)
  lib/                     tauri wrapper, themes, constants, monaco-setup
  types.ts                 shared TS types mirroring Rust DTOs

src-tauri/src/             backend
  commands/                Tauri command handlers (the public API)
  db/                      pool / sql / values helpers (driver-agnostic)
  keychain.rs              centralised keyring access
  state.rs, store.rs       state + disk persistence
  error.rs                 AppError / AppResult
```

Two starter files for new contributors: `src-tauri/src/lib.rs` and `src/App.tsx`.

## Hard-earned gotchas

These bit us during the first sessions. Don't repeat them.

1. **Zustand selectors must return reference-stable values.**
   Anything like `s => s.entries.filter(...)`, `s => [...a, ...b]`, or `s => allThemes(s)` returns a fresh array each call → `Object.is` always differs → infinite re-render → React caps update depth.
   **Rule**: subscribe to the raw state, derive arrays/objects with `useMemo` in the component. The store has a banner comment in `src/stores/theme.ts` reinforcing this — don't undo it. CONTRIBUTING.md also documents the rule under "Coding standards → TypeScript / React".

2. **Monaco is bundled, not CDN-loaded.**
   `src/lib/monaco-setup.ts` wires workers via Vite `?worker` imports and calls `loader.config({ monaco })`. Without this, the SQL editor and the cell editor go blank when Tauri can't reach `cdn.jsdelivr.net`. Don't reintroduce a CDN dependency; if you add a new Monaco language, add its worker here.

3. **`tauri::State<'_, T>` does NOT auto-deref into `&T` at call sites.**
   Use `state.inner()` to get `&AppState`. Every helper that takes `&AppState` (e.g. `pool_for`) is called with `state.inner()`, not `&state`.

4. **`quote_ident` is for catalog-sourced identifiers, not arbitrary user input.**
   Documented in `src-tauri/src/db/sql.rs` and in `SECURITY.md`. User input always goes through bound parameters (`$1` / `?`).

5. **`update_cell` value is `Option<String>` end-to-end.**
   The cell editor only emits text; drivers cast textual literals server-side. Don't try to push `serde_json::Value` through it — `sqlx` postgres won't encode `Value` to arbitrary column types.

6. **The MySQL `order_clause` previously had a brittle string-rewriting hack** to convert `"col"` → `` `col` ``. Now `fetch_table_data` computes `pg_or_sqlite` once and passes the right boolean to `quote_ident` from the start. Don't reintroduce the hack.

7. **Repo name vs product name.** GitHub slug is `huggin` (two g's), product is `Huginn`. If we rename the repo on GitHub later, also update the two URLs in `README.md` and `CONTRIBUTING.md`.

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
# then in Huginn: + connection → SQLite → path to chinook.db
```

`sample-data/` is gitignored on purpose — don't commit fixtures.

First build is **slow** (5–10 min) because Cargo compiles all three `sqlx` drivers + `keyring` + `tokio` from scratch. Incremental rebuilds are <10 s.

The Rust toolchain + MSVC Build Tools (Windows) are prerequisites; the user already has both. Tauri's per-platform deps are in the README.

## Architecture invariants

- The **frontend never talks to a database directly.** All DB I/O lives in Rust commands. The frontend uses the typed wrapper at `src/lib/tauri.ts` — do not call `invoke` from components.
- **Passwords never hit disk in plaintext.** `keyring` is the only persistence path. Profile metadata (host, port, db, username, SSL toggle, driver) lives in JSON inside the platform config dir; the password is keyed by `${profile.id}::${username}` in the OS keychain.
- **CSP is `null` on purpose** because Monaco loads its workers as blobs. Workers themselves are bundled (no remote fetch), so the relaxation is narrow. Tightening CSP is on the roadmap.

## Current status (post-session 2)

- 10 commits on `main`, pushed to GitHub. All authored as `Alexfp28 <alexlopezdelafuente@gmail.com>` after a one-time `filter-branch` rewrite at publish time.
- No tests. No CI. No screenshots in the README yet.
- macOS is not a primary target; build should work but unverified.

## Roadmap (priority order from README)

1. **SSH tunnel** — UI fields and `SshTunnel` type already exist; backend wiring is the next major feature. The user explicitly flagged this for the next alpha. Likely approach: spawn `russh` / `russh-tokio` tunnel before opening the `sqlx` pool, point the pool at `127.0.0.1:<local>`.
2. Bulk row insert / delete in the data browser.
3. Schema diff & export (DDL extraction, side-by-side compare).
4. More drivers — MSSQL, ClickHouse, DuckDB. Recipe in `CONTRIBUTING.md`.
5. Table-structure editor (visual `ALTER TABLE`).
6. Tighter CSP.
7. Tests — `testcontainers-rs` for ephemeral Postgres/MySQL, Playwright for the frontend.
8. macOS bundle with code signing.
9. Visual query builder (low priority — Monaco is fast enough that most users probably won't want one).

## Explicitly out of scope (don't propose unless asked)

- Reorganising components into per-feature folders. Flat layout is fine at this size.
- Adding a linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy` advice in CONTRIBUTING.
- AI features (autocomplete suggestions via LLM, "explain this query", etc.).
- Cloud sync of profiles or saved queries.
- Mobile builds — the Tauri icon CLI generated iOS/Android directories during scaffolding, but desktop is the focus.

## When the user asks for "the next thing"

- Default to **finishing roadmap item 1 (SSH tunnel)** unless they say otherwise — they explicitly parked it for this alpha.
- Always ask before adding new dependencies; the user prefers a small, audited tree.
- Keep PRs / commits scoped. The user values legible history and will read the long-form commit body.

## Communication style

- Replies in Spanish, terse, no fluff. The user reads diffs and runs commands themselves; they don't need a walkthrough.
- One sentence before a tool batch is enough.
- End-of-turn summary: ≤ 2 sentences. What landed, what's next.
- When proposing a non-trivial change, ask 1–2 scoping questions with `AskUserQuestion` rather than guessing.
