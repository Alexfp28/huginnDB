# CLAUDE.md

Project context for Claude Code sessions on this repo. Skim this first; reach for `README.md` / `CONTRIBUTING.md` / `SECURITY.md` for the public-facing detail.

## Identity

- **HuginnDB** — desktop database manager, Tauri 2 (Rust backend) + React + TypeScript frontend.
- Targets PostgreSQL, MySQL, SQLite, **and MongoDB**. Inspired by HeidiSQL but minimal-UI / keyboard-first / Monaco-everywhere.
- Public repo: <https://github.com/Alexfp28/huginnDB>.
- License: MIT. Status: **1.8.x** (stable; SemVer applies). MongoDB support and the headless MCP connector (`huginndb-mcp`) landed across the 1.5–1.8 line.

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
| DB drivers  | `sqlx` 0.8 (`postgres`, `mysql`, `sqlite`) + `mongodb` 3 (`bson-3`) |
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

src-tauri/src/             backend (workspace root; see mcp-server/ below)
  commands/                Tauri command handlers (the public API)
  db/                      pool / sql / values helpers (driver-agnostic)
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

7. **DataGrid cell-mutation callbacks pass `row.original` (the full values array), NOT a row index.** The previous index-based contract corrupted data when the user had `globalFilter` active: TanStack's `row.index` is the *filtered display* index, while parents resolved the PK from `result.rows[index]` (the unfiltered backend page). The two diverge as soon as the client filter is non-trivial. Anything that needs identity (PK lookup, delete, duplicate, FK overlay anchor) reads from the values array passed to the callback. See `DataGrid.tsx` props + `TableDataTab.pkValueFromRow`.

8. **`tab_state.json` is v3 — a flat `connections` map, and only the main window ever touches it.** "Workspaces" (v2, shipped 0.5.0–1.3.0) were a stand-in for real per-window instances; 1.4.0 removed them. A v2 blob discards every workspace except the active one on load (confirmed product decision — no merge semantics); a v1 blob (already flat) just gets its version bumped. `prefs::get_tab_state` / `save_tab_state` / `clear_tab_state` read/write `state.tab_state.connections` directly — no per-window scoping on the backend at all. Secondary windows opened via `open_new_window` ("New window") are ephemeral entirely on the **frontend** side: `persistedTabs.ts::hydrateTabState` early-returns unless `getCurrentWindow().label === "main"`, so a secondary window never calls `getTabState`/`saveTabState` and therefore never touches the file. If you add a new tab-state-aware command, keep that main-window-only guard — a secondary window silently reading or writing the shared blob would corrupt the main window's session.

9. **Monaco swallows `Ctrl+Enter` and friends inside its focus area; a `window` keydown listener never sees them.** That's why `QueryEditorTab` binds Ctrl+Enter via `editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, …)` inside `handleMount`, not via `window.addEventListener`. Because `addCommand` keeps its handler closure for the lifetime of the editor, the handler reads `runQueryRef.current()` rather than capturing `runQuery` directly — otherwise it would freeze to the first render's `sql` and `running` values. Same ref pattern applies to the completion provider and the CodeLens provider. **Crucially, those two providers — plus `registerCommand` — are GLOBAL to the language, not per-editor: registering them inside `handleMount` once per query tab caused N duplicate "▶ Run" lenses (and N× autocomplete entries) with N tabs open.** They now live in `src/lib/monacoSql.ts`, installed exactly once per Monaco instance (`ensureSqlProviders`, guarded on the instance) and dispatched per model via a registry each editor populates on mount (`registerSqlEditor`) and clears on unmount. `editor.addCommand` (Ctrl+Enter, Ctrl+K) IS per-editor and stays in `handleMount`.

10. **The workspace editor is a *nested* dockview synced to `useTabs`, which stays the source of truth.** `TabbedArea.tsx` hosts an inner `DockviewReact` (separate from the outer Schema/Saved/Workspace/Console dockview in `App.tsx`); each open table/query tab is a panel. The reconciler only flows **store → dockview** for add/remove (a `useEffect` on `tabs` adds missing panels, removes stale ones); the custom tab's X button and middle-click call `useTabs.close`, never `panel.api.close()`, so removal can't feed back on itself. Active-panel sync is bidirectional but idempotent (`onDidActivePanelChange` → `setActive`; an effect mirrors `activeId` → `panel.api.setActive()`, a no-op when already active). Don't add a second add/remove path or make the close affordances mutate dockview directly. Persistence (`persistedTabs.ts`) derives its per-connection snapshot from `useTabs`; **as of 1.0.2 split/float geometry IS persisted** via `ConnectionTabState.internalLayout` (a raw dockview `toJSON()` blob, captured only when there's >1 group). On hydrate the blob is handed to `TabbedArea` (`setPendingInternalLayout`) and replayed with `fromJSON` **first** — `fromJSON` is the authoritative panel+geometry rebuild (it recreates panels from the params we stored at `addPanel`), so the store→dockview reconciler then runs as an idempotent convergence pass. `fromJSON` is wrapped in try/catch: on drift it falls back to the default tabbed layout (the old behaviour). The inner dockview API is exposed to `persistedTabs` via the `registerInnerDockviewApi`/`getInnerDockviewApi` singleton in `dockview.ts`, mirroring the outer one.

11. **`sqlx` rejects `try_get::<Vec<u8>>` on a MySQL `BIT` column** (its blob compatibility check accepts only BLOB/STRING/VARBINARY). See gotcha #15 for the full, current MySQL integer/`BIT` decode + write story — it supersedes this note.

12. **Double-click on a data-grid cell edits inline, not in a modal.** `DataGrid.openCellEdit` routes by column: single-column FK → `FkCombobox`; editable cell → inline `CellInput` (the shared input also used by the insert draft row, with an *expand* button that escalates to the Monaco `CellEditor`); read-only query result → the modal as a viewer. `inlineEdit` is tracked by the row's *values array* identity (gotcha #7), not a display index. The inline commit no-ops when the value is unchanged, which is what makes the blur fired during *expand* harmless. Don't route double-click straight to the modal again.

13. **Grid "zoom" is a single persisted px value: `gridPrefs.rowHeight`.** `DataGrid` derives cell height, padding and font-size from it (via inline `style`, since the values are dynamic and can't be Tailwind classes) and adjusts it on `Ctrl`+wheel (bound as a **non-passive** native listener so `preventDefault` suppresses page-zoom — a JSX `onWheel` is passive and can't). The `TableDataTab` toolbar `+`/`−` buttons nudge the same pref. It already round-trips through `prefs.json`; no backend change is needed to use it. Subscribe to it as a primitive (gotcha #1).

14. **A field that round-trips through a typed Tauri command must be declared in the Rust struct, or serde silently drops it.** `save_tab_state` deserializes its IPC payload into the strongly-typed `ConnectionTabState` (`tab_state.rs`), which has `#[serde(default)]` but no `#[serde(flatten)]` catch-all. Unknown JSON keys are discarded on deserialize, so a "frontend-only" field survives the IPC argument shape but is gone the instant the Rust struct is rebuilt — before it's written to disk. This bit the `internalLayout` work (gotcha #10): it had to be added to *both* `src/types.ts` and the Rust struct (as `Option<serde_json::Value>`, stored opaquely). Same rule for any new persisted field on a typed command boundary.

15. **MySQL integer/`BIT` decoding is width- and type-specific (`mysql_value` in `src-tauri/src/db/values.rs`).** sqlx maps each MySQL integer width to one Rust type and rejects a mismatched `try_get`: `TINYINT`→`i8`, `… UNSIGNED`→`u8`/`u16`/`u32`/`u64`, etc. The `contains("INT")` branch therefore tries signed widest-first then unsigned, falling back across widths before surrendering to `Value::Null` — without this, bare `TINYINT`/`SMALLINT` and any unsigned column rendered as "NULL". `BIT` is decoded via `try_get::<u64>` (sqlx special-cases `ColumnType::Bit`; `Vec<u8>` is rejected). **A MySQL `TINYINT(1)`/`BOOL`/`BOOLEAN` column is reported by sqlx as the type name `"BOOLEAN"`** (see `ColumnType::name`: `Tiny` with display width 1 → `"BOOLEAN"`; a plain `TINYINT` stays `"TINYINT"`, and the width is never in the name — so `"TINYINT(1)"` is a name sqlx never emits). Since `"BOOLEAN"` does **not** contain `"INT"`, it must be routed into the integer branch explicitly (`contains("INT") || name == "BOOLEAN"`); the old `name == "BOOL" || name == "TINYINT(1)"` guard never matched, so booleans fell through to the `String` fallback and rendered as "NULL" (issue #68, fixed 1.9.0). We decode it as the underlying integer (0/1), not a Rust `bool`, because a `TINYINT(1)` can hold any small int (2, -1, …) and forcing `bool` would lose that. On the *write* side, editing a MySQL `BIT` cell needs `SET col = CAST(? AS UNSIGNED)` — a plain textual literal `"1"` is stored as the ASCII byte `0x31`, not the integer 1; `update_cell` takes an optional `column_type` from the frontend to detect this (a `BOOLEAN`/`TINYINT` needs no such cast — a textual `"1"` casts to the integer 1 fine).

16. **The table-structure editor builds DDL in Rust, never in the component.** `StructureEditorTab.tsx` sends the desired `TableStructure` (+ the original snapshot when editing) to `preview_structure_change` / `apply_structure_change`; the pure builder in `src-tauri/src/db/ddl.rs` (`build_ddl`) diffs them and returns the ordered statements. Preview and apply call the *same* builder so what's shown is what runs. DDL can't use bound parameters for identifiers, so every user-entered name goes through `validate_ident` before quoting, and types/defaults through `validate_type`/`validate_default` (conservative allowlists) — this is the SECURITY.md "user input never reaches `quote_ident`" rule's one sanctioned exception, mediated by validation. A rename-vs-drop+add is told apart by each `ColumnDef.original_name` (the diff matches on it). SQLite changes that `ALTER TABLE` can't express (type/nullability/PK/FK) trigger the 12-step rebuild in `build_sqlite_rebuild`; `preview` flags `rebuild: true` so the UI shows a destructive confirmation. Apply runs PG in one transaction, MySQL statement-by-statement (DDL is non-transactional there), and SQLite verbatim (the rebuild manages its own `PRAGMA foreign_keys` toggles outside any tx). Structure tabs are **not** persisted (filtered out in `persistedTabs.ts`) — they're ephemeral editing sessions.

17. **MySQL `BLOB`/`TEXT` are disambiguated by content, not just the type name (`mysql_value`, gotcha #15's neighbour).** sqlx derives the column type name (`LONGTEXT` vs `LONGBLOB`, `TEXT` vs `BLOB`, …) purely from the protocol-level `ColumnFlags::BINARY` bit, which the MySQL server *sometimes* sets on genuine text columns depending on charset/collation — so a real `LONGTEXT` arrives named `LONGBLOB` and used to render as a hex dump. The flag isn't reachable through sqlx's public API. The `contains("BLOB") || contains("BINARY")` branch therefore reads the **raw bytes** via `try_get::<Vec<u8>>` and runs `String::from_utf8` itself: valid UTF-8 → text, otherwise hex. **Crucially it must NOT use `try_get::<String>` first** — `try_get` runs sqlx's *type-compatibility* gate before decoding, and `String` is incompatible with a `BINARY`-flagged column, so it returns `Err` *without ever inspecting the bytes*; a pristine UTF-8 `LONGTEXT` (e.g. a big JSON document) then always collapsed to hex (the 1.0.10 bug). `Vec<u8>` is compatible with BLOB, so reading bytes + validating ourselves decides text-vs-binary by content. Tradeoff: a true binary blob that happens to be valid UTF-8 renders as text (same as HeidiSQL). Don't revert to `try_get::<String>` or to unconditional hex.

18. **SSH tunnel local-port bind falls back to an ephemeral port on collision (`open_tunnel` in `src-tauri/src/db/ssh.rs`).** If the user pinned a fixed `local_port` and something else already holds it (e.g. another hand-opened tunnel on the same port), `TcpListener::bind` fails with `AddrInUse`; instead of breaking the connection we retry `bind(("127.0.0.1", 0))` and let the OS pick a free port. This is transparent because the pool is pointed at the **bound** port returned on `SshTunnelHandle.local_port`, not at `tunnel.local_port`. The saved profile is never rewritten — the override lives only for that tunnel's lifetime. `local_port = 0` (auto) skips the fallback since it can't collide.

19. **`WebviewWindowBuilder::new(...).build()` must be called from an `async fn` Tauri command, never a sync one.** `commands::connection::open_new_window` hit this: a sync command building a new `WebviewWindow` on Windows deadlocks — a documented WebView2 issue — and the symptom is *not* an error, it's a window that renders blank/white and Windows tags "Not Responding". Wrapping the `build()` call in `AppHandle::run_on_main_thread` looked like a fix (the hang went away) but the window still came up blank; only marking the command `async fn` actually works, per Tauri's own docs and [tauri#13963](https://github.com/tauri-apps/tauri/issues/13963). If you add another command that creates a window, make it `async fn` from the start.
20. **`huginndb-mcp` lives in its own workspace crate (`src-tauri/mcp-server/`), never as a second `[[bin]]` in the app's own `Cargo.toml`.** It used to be exactly that (`src/bin/mcp.rs`, gated behind `required-features = ["mcp"]`), which built and ran fine — until the 1.7.0 release build switched Windows bundling from MSI to NSIS (see below) and immediately broke with `failed to bundle project when getting size of ...\mcp.exe: The system cannot find the file specified`. `tauri-bundler`'s Windows bundling enumerates *every* `[[bin]]` target in the package's own `cargo metadata`, regardless of `required-features` gating, and tries to size/bundle each one — including a binary a normal `pnpm tauri:build` never compiles. This is a known, still-open upstream limitation (tauri-apps/tauri#4807, #14176), not something fixable from `tauri.conf.json` (no config exists to exclude a `[[bin]]` from bundling). The fix is structural: move the extra binary to a sibling workspace package. Since `huginndb-mcp` was already a thin shim over `huginndb_lib::mcp::serve()` (the real logic lives in the lib crate's `mcp` module, still gated behind the `mcp` feature), the split was just a new `Cargo.toml` + `main.rs` in `mcp-server/`, a `[workspace] members = ["mcp-server"]` in the app's `Cargo.toml`, and deleting the old `[[bin]]` block — no logic moved. `cargo metadata` for the `huginndb` package alone now reports exactly one bin target, so tauri-bundler never sees the MCP binary at all. Build it with `cargo build -p huginndb-mcp --release` from `src-tauri/` (not `--features mcp --bin huginndb-mcp` anymore — that flag still *works* since the feature still gates the lib-crate logic, but the binary target it used to select no longer exists in this package).
21. **Windows installer target is NSIS, not MSI/WiX — don't switch it back without a real reason.** 1.7.0's release build reliably failed bundling the `.msi`: WiX v3 (what `tauri-action` shells out to for MSI) has been archived/unmaintained since February 2025, and its `light.exe` reliably failed to even launch on GitHub's Windows runners — a bare `failed to run ...light.exe`, no WiX diagnostic — regardless of runner OS generation (reproduced identically on both `windows-2022` and the newer `windows-latest`/Server 2025 image GitHub migrated to in June 2026) and regardless of a Windows Defender exclusion or installing the VBSCRIPT optional feature (both ran clean, neither changed the outcome). `candle.exe` always ran fine against the same freshly-downloaded WiX binaries; only `light.exe` failed, matching the historically-known pattern of Defender/AV heuristics flagging that specific binary across the Actions fleet (tauri-apps/tauri#2486, #2640, #10649) — a signature-side issue outside the repo's control, and one WiX v3 will never receive a fix for. `tauri.conf.json`'s `bundle.targets` is `["nsis", "deb", "appimage"]`. Tauri officially supports MSI → NSIS as an update path (not the reverse): the auto-updater's `latest.json` doesn't care about installer format, and NSIS detects a prior WiX MSI install and handles it (a `tauri-bundler` v1.3.0+ capability; the pinned `@tauri-apps/cli` here is 2.11.1, well past it).
22. **`huginndb-mcp` ships as a Tauri sidecar (`bundle.externalBin`), staged by the release workflow, not built by `pnpm tauri:build` itself.** Before 1.7.0 shipped, the connector was reachable only by cloning the repo and running `cargo build -p huginndb-mcp` yourself — no packaged install ever contained the binary, which defeated the point for anyone who wasn't already a contributor. The release workflow has a step (`Build and stage the huginndb-mcp sidecar`) that builds the `mcp-server` crate and copies it to `src-tauri/binaries/huginndb-mcp-<target-triple>[.exe]` — the exact naming Tauri's `externalBin` convention requires — *before* the `tauri-action` build step, so `tauri-bundler` finds it and ships it next to the main executable. `src-tauri/binaries/` is gitignored (build output, not source). **`tauri-build` (`huginndb`'s `build.rs`) hard-fails *any* compile of `huginndb_lib` — even a bare `cargo check`, even just as a dependency of `huginndb-mcp` itself — if the externalBin resource for the current target triple isn't already on disk** (existence only; content doesn't matter at compile time). That's a real circular dependency once `externalBin` is configured: building `huginndb-mcp` requires compiling `huginndb_lib` (with the `mcp` feature) first, and that compile now refuses to proceed without a sidecar file that only building `huginndb-mcp` produces. The workflow step works around it by `touch`-ing empty placeholders at both possible sidecar paths (with/without `.exe`) *before* `cargo build -p huginndb-mcp`, then `rm -f`-ing and `cp`-ing the real binary over — not overwriting the placeholder in place, since `cp` onto an existing file keeps that file's (non-executable) mode, which would silently ship a broken sidecar. If you touch this step, keep both halves. `commands::mcp::get_mcp_connector_info` resolves the *installed* sidecar's path via `std::env::current_exe()`'s parent directory — confirmed by inspecting a real `.deb` build (`dpkg-deb -c`), which places both `huginndb` and `huginndb-mcp` in the same `usr/bin/`; this is why the command doesn't need `tauri-plugin-shell` (that's for *spawning* a sidecar from within the app, which we don't do — an external AI client spawns it, we just need to tell the user where it is). Settings → MCP (`McpSection.tsx`) is the UI: it shows this path, lets the user pick which saved profiles to expose, and generates the `claude mcp add` / JSON snippet — see `docs/MCP.md`.
23. **A running `huginndb-mcp.exe` blocks the in-app self-updater from overwriting the sidecar, and the failure looks like a permissions error.** `installMode` for the NSIS bundle is left at Tauri's default (`currentUser`, writing under `%LOCALAPPDATA%`) — no admin prompt is expected, and none is needed for a plain per-user install/update. But Tauri's generated NSIS template only knows how to close a running instance of the *main* `huginndb.exe` before overwriting it; it has no idea `huginndb-mcp.exe` exists, since that process is spawned independently by whatever external MCP client has it configured (Claude Desktop, Claude Code, ...), never by HuginnDB itself. If a client still has the sidecar running when `useUpdateStore.installAndRelaunch` (`src/stores/update.ts`) downloads and silently runs the new installer, Windows holds a lock on `huginndb-mcp.exe` and the overwrite fails with `ERROR_SHARING_VIOLATION` — surfaced to the user as a generic access-denied/permissions failure, even though no elevation is actually missing. Fixed via a `NSIS_HOOK_PREINSTALL` installer hook (`src-tauri/windows/hooks.nsi`, wired through `bundle.windows.nsis.installerHooks` in `tauri.conf.json`) that force-kills `huginndb-mcp.exe` before any files are copied; the MCP client simply respawns it next time it needs the connector. Don't remove the hook, and if the sidecar's binary name ever changes, update the `taskkill /IM` target to match.
24. **The updater only ever checked on launch, so an instance that's never closed never sees a published release.** `useUpdateStore.checkOnLaunch` used to be the sole trigger — fine for a normal restart cadence, useless for a machine that leaves HuginnDB open for days. `startPeriodicChecks` (called once from `App.tsx` alongside `checkOnLaunch`) re-runs the same check on a `setInterval` (4h, module-level timer guarded against double-start so a StrictMode double-effect can't stack two). The important constraint this introduced: `install()` (the step that overwrites files, force-kills the MCP sidecar per gotcha #23, and can prompt for Windows elevation) must **never** run unattended — only `download()` is safe to run silently in the background. So `runCheck`, on finding an update, immediately kicks off `startBackgroundDownload` (a *download-only* call), which lands the store in a new `readyToRestart` status once the bytes are in; `installAndRelaunch` only calls `install()` + `relaunch()` when the user explicitly clicks (whether that's a fresh "Install" click that also happens to start the download, or a "Restart now" click against an already-downloaded update — same code path, gated on `_downloadPromise`/status so neither `download()` nor `install()` ever double-fires against the same `Update` instance). One more wrinkle worth knowing: `install()` must be called on the *exact* `Update` object that `download()` ran on — the plugin tracks the downloaded bytes on that instance internally — so `runCheck` deliberately does **not** replace `_update` with a fresh instance from a later poll when it's still the same version already mid-download or sitting at `readyToRestart`; it only replaces `_update` when a genuinely newer version appears. Because `install()` force-kills the MCP sidecar, `installAndRelaunch` also calls the new `is_mcp_sidecar_running` command (`commands::mcp`, a `tasklist`/`pgrep` shell-out — no new crate) first and, if positive, confirms with the user via `window.confirm` before proceeding (this one is intentionally *not* gated behind the `confirmDestructive` preference, same reasoning as the DROP TABLE dialog in `lib/confirmDestructive.ts` — interrupting someone else's live AI session is a different safety tier than a local data-loss confirmation).

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
| `profiles.json`         | `src-tauri/src/store.rs`           | Connection metadata only. Passwords in OS keychain. |
| `prefs.json`            | `src-tauri/src/prefs.rs`           | User preferences (editor / grid / ui). Atomic temp-file + rename on write. Bad JSON falls back to `Preferences::default()` — never blocks startup. |
| `tab_state.json`        | `src-tauri/src/tab_state.rs`       | **v3 since 1.4.0** — flat top-level shape `{ version, connections }` (LRU-pruned to 20; query bodies capped at 64 KB). Written only by the main window (see gotcha #8); v2 "workspaces" blobs are migrated by discarding every workspace except the active one. |
| `*.window-state.json`   | `tauri-plugin-window-state` v2     | Plugin-owned; do not parse manually. Removes need for a hand-rolled `window.rs`. |

Theme + dockview layout still live in `localStorage` (keys `huginndb.theme.v2` and `huginndb.layout`) — synchronous read pre-mount avoids FOUC. Don't migrate these to disk without a plan for the flash.

## Current status (post-session 3)

- Released 0.5.0: workspace switcher with reorder/colour/icon, "Copy row as ▸ JSON/INSERT/UPDATE" submenu, connection-level filter in multi-DB explorer, and the fix for the cell-save row-mismatch bug under client filters.
- Released 0.6.0 right after: Ctrl+Enter restored, per-statement "▶ Run" CodeLens, driver-aware keywords in the autocomplete (Postgres `RETURNING`, MySQL `ON DUPLICATE KEY UPDATE`, …) with tables-first sort.
- Backend has `cargo test` coverage for the v1/v2→v3 tab-state migration and prune semantics; no frontend tests or CI yet.
- Released 1.4.0: removed workspaces in favour of native per-window instances — "New window" in the new **Window** menu opens a blank, ephemeral secondary window; see gotcha #8 and `docs/1.4.0_ROADMAP.md`. Same cycle also split the topbar File/View menus into four (File/Window/View/Help — File had accumulated unrelated window/help actions), fixed two bugs (`open_new_window` must be an `async fn` on Windows — sync commands deadlock creating a `WebviewWindow`, a WebView2 issue — and CLI ad-hoc launches without `--password` now always attempt the connect instead of silently staying disconnected), added server-side users/permissions introspection (a "Security" panel, implemented for every driver including SQLite's explicit no-user-model empty state — `commands::schema::list_users`/`list_privileges`), and added a background connection keepalive + lost-connection reconnect UX (`src-tauri/src/keepalive.rs` — a 3-minute heartbeat per top-level connection; a failed ping flags the connection in `stores/connectionHealth.ts` and both `ConnectionList`/`StatusConnections` offer a one-click reconnect instead of the user hitting a cryptic driver error mid-query).
- macOS is not a primary target; build should work but unverified.

## Roadmap (priority order from README)

1. **SSH tunnel** — UI fields and `SshTunnel` type already exist; backend wiring is the next major feature. The user explicitly flagged this for the next alpha. Likely approach: spawn `russh` / `russh-tokio` tunnel before opening the `sqlx` pool, point the pool at `127.0.0.1:<local>`.
2. ~~Bulk row insert / delete in the data browser.~~ Bulk delete + multi-select shipped in 1.0.2; bulk insert still open.
3. Schema diff & export (DDL extraction, side-by-side compare).
4. More drivers — MSSQL, ClickHouse, DuckDB. Recipe in `CONTRIBUTING.md`.
5. ~~Table-structure editor (visual `ALTER TABLE`).~~ Shipped in 1.0.2 — see gotcha #16.
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
