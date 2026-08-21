# Contributing to HuginnDB

Thanks for taking the time to contribute. HuginnDB is a young project; clear, well-scoped contributions are the fastest way to get changes shipped.

## Ground rules

- **Be respectful.** Treat the issue tracker and PR reviews as professional spaces. We have no patience for hostility.
- **One change per PR.** A bug fix, a feature, or a refactor — pick one. PRs that mix concerns will be sent back for a split.
- **Keep PRs small.** Reviews are easier and merges are faster when the diff fits on a screen.
- **No drive-by reformatting.** If you reformat existing code, do it in a separate commit (and ideally a separate PR).

## Filing issues

Before opening an issue:

1. Search [existing issues](https://github.com/Alexfp28/huginnDB/issues) to avoid duplicates.
2. Reproduce on the latest `main`.
3. Include: OS, Rust toolchain version (`rustc -V`), Node version (`node -v`), pnpm version, the database engine and version you were targeting, and the smallest sequence of steps that reproduces the problem.

Bug reports without reproductions will be triaged last.

## Setting up a dev environment

See the [README](README.md#prerequisites) for the full list. The short version:

```bash
pnpm install
pnpm tauri:dev
```

That launches the Tauri shell with HMR for the React frontend and `cargo` rebuilds for the Rust backend.

## Project layout

```
src/                   React + TypeScript frontend
  components/          Feature components, grouped by domain (each with an optional dialogs/ subfolder for modal-only components)
    ui/                shadcn-style primitives
    common/            Cross-domain leaf components (DriverBadge, VanishedOriginNotice)
    connection/        Connection profiles, tree, status
    schema/            Schema explorer, structure/view/security tabs
    query/             Query editor, console, saved queries
    grid/              Data grid + cell editing
    menus/             Top bar menus (File/Window/View/Help)
    shell/             App shell: tabs host, status bar, command palette, banners
    settings/          Settings dialog + its sections/
    aggregation/       MongoDB pipeline editor
    indexes/           MongoDB index manager
    jsonSchema/        JSON Schema library + binding pickers
  stores/              Zustand stores, grouped:
    session/           connections, tabs, schema, environments, ui, persistedTabs
    preferences/       preferences, theme, appFlavor
    dialogs/           open-state for modals reachable from several surfaces
    grid/, query/, sync/
  lib/                 Tauri command wrappers, helpers, themes, constants; grouped:
    monaco/            editor setup, themes, language providers
    bridges/           one module per `huginndb://` event
    db/, grid/, sql/, schema/, tabs/, transfer/, mongo/, commandPalette/,
    connection/, jsonSchema/, appInfo/, i18n/
  types.ts             Shared TS types mirroring the Rust DTOs

src-tauri/             Rust backend
  src/
    commands/          Tauri command handlers (the public API surface)
    db/                Database abstraction layer:
      sql.rs           Dialect — the per-engine SQL *text*
      exec.rs          the per-engine *execution* (see CLAUDE.md gotcha #42)
      postgres/ mysql/ sqlite/ mssql/ mongo/   catalog SQL, per driver
    keychain.rs        OS keychain integration
    state.rs           Active pools + saved profiles
    store.rs           On-disk persistence (profiles.json)
    state_file.rs      The one path/load/atomic-save for every JSON state file
    error.rs           Common error type
```

When in doubt, read `src-tauri/src/lib.rs` and `src/App.tsx` first — they're the entry points and reference the rest of the codebase.

## Coding standards

### Rust

- Use `rustfmt` defaults: `cargo fmt --all` before pushing.
- `cargo clippy --all-targets --all-features -- -D warnings` should pass.
- Public items get a Rustdoc comment. Internal helpers don't have to, unless their behaviour is non-obvious.
- Never `unwrap()` outside of tests or `build.rs`. Use `?` with `AppError` instead.
- Errors that cross the FFI boundary go through `AppError`; do not return ad-hoc strings.

### TypeScript / React

- Run `pnpm typecheck` and `pnpm test` before pushing — CI runs both.
- Tests are Vitest, colocated as `*.test.ts(x)`. There is no blanket suite: the
  convention is a characterization test for anything pure or hook-shaped you
  extract, written before the extraction so it pins the current behaviour.
  `pnpm test:watch` while you work.
- Stores live in `src/stores/`, command wrappers in `src/lib/tauri.ts`. Components never call `invoke` directly.
- Zustand selectors must return reference-stable values. If you need a derived array/object, subscribe to the raw state and memoise in the component. See the warning at the bottom of `src/stores/preferences/theme.ts` for the historical reason.
- Avoid CDN-loaded assets. Anything needed at runtime must be bundled (Monaco is the canonical example — see `src/lib/monaco/monaco-setup.ts`).

### Commits

We use a lightweight [Conventional Commits](https://www.conventionalcommits.org/) style:

```
<type>(<scope>): <short summary>

<long description with context and rationale>
```

Types we use: `feat`, `fix`, `refactor`, `docs`, `chore`, `perf`, `test`.

Examples:

- `feat(query): add Ctrl+Shift+Enter to run only the selected SQL`
- `fix(theme): avoid infinite re-render when selector returned a new array`
- `refactor(backend): centralise keychain access in src-tauri/src/keychain.rs`

Long-form messages are expected for non-trivial changes. Explain *why* the change is needed, not just what it does — the diff already shows the latter.

## Pull requests

- Branch off the latest `main`.
- Open a PR with a meaningful title (same convention as commits).
- Fill in the PR description: what it does, why, how it was tested, and any screenshots for UI changes.
- Mark the PR as draft if it's not ready for review.
- At least one approval is required before merging.

## Adding a new database driver

Adding a sixth driver (ClickHouse, DuckDB, etc.) touches:

1. `Cargo.toml` — the driver crate. **Not necessarily a `sqlx` feature**: `sqlx`
   0.8 covers Postgres/MySQL/SQLite only, so MongoDB (`mongodb`) and SQL Server
   (`tiberius`) each bring their own client — and, in SQL Server's case, its own
   connection pool, since `tiberius` has none. Discuss the dependency first
   (see the small-tree preference in `CLAUDE.md`).
2. `src-tauri/src/state.rs` — extend the `Driver` and `DbPool` enums, plus
   `Driver::wire_name`. Any driver-specific connection settings go in a nested
   struct (`MsSqlOptions`-style), not as new top-level profile fields.
3. `src-tauri/src/db/sql.rs` — add a `Dialect` variant. This is where identifier
   quoting, placeholders, the text cast, `LIKE` semantics and pagination live;
   getting it right here means most of the command layer needs no per-driver
   code at all.
4. `src-tauri/src/db/pool.rs` — connection construction (URL builder for a
   `sqlx` driver, or an early return into your own module otherwise) +
   `smoke_test`, and `src-tauri/src/keepalive.rs` — the liveness ping.
5. Row → JSON decoding: `src-tauri/src/db/values.rs` for a `sqlx` driver, or a
   `values.rs` inside your own module (see `db/mssql/`, `db/mongo/`).
6. `src-tauri/src/commands/` — the compiler will point at every `match` on
   `DbPool` that needs an arm: `schema.rs` (introspection), `query.rs`
   (execute/browse/count/insert/update/delete/FK lookups), `bulk.rs`,
   `structure.rs`, `view.rs`, `dump.rs`, `connection.rs`. Watch for arms that
   are *not* exhaustive-checked; a `_ =>` here silently routes a new driver
   down another engine's path.
7. DDL, if you implement it: `src-tauri/src/db/ddl.rs`, `db/view_ddl.rs` and
   `db/dump.rs`. All three are pure builders with unit tests — start there.
8. Frontend: `src/types.ts` (the `Driver` union), `src/lib/constants.ts`
   (default port), `src/components/common/DriverBadge.tsx` + an SVG in
   `public/image/db/`, `src/lib/db/driver.ts` (CLI aliases + capability gates),
   `src/lib/db/columnTypes.ts`, `src/lib/sql/sqlKeywords.ts`,
   `src/components/connection/dialogs/ConnectionDialog.tsx` and
   `AdHocDriverDialog.tsx`, `src/components/settings/sections/GeneralSection.tsx`,
   and **both** i18n locales. `DriverBadge`'s `Record<Driver, …>` is the only
   thing that fails to compile; the rest are hardcoded lists `tsc` can't see.

Open an issue first if you're planning this so we can agree on the scope.

## Security

Security-sensitive bugs should not be filed in the public issue tracker. See [SECURITY.md](SECURITY.md).
