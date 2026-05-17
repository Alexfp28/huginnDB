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
  components/          UI + feature components
    ui/                shadcn-style primitives
  stores/              Zustand stores
  lib/                 Tauri command wrappers, helpers, themes, constants
  types.ts             Shared TS types mirroring the Rust DTOs

src-tauri/             Rust backend
  src/
    commands/          Tauri command handlers (the public API surface)
    db/                Database abstraction layer (pool, sql, values)
    keychain.rs        OS keychain integration
    state.rs           Active pools + saved profiles
    store.rs           On-disk persistence
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

- Run `pnpm tsc --noEmit` before pushing.
- Stores live in `src/stores/`, command wrappers in `src/lib/tauri.ts`. Components never call `invoke` directly.
- Zustand selectors must return reference-stable values. If you need a derived array/object, subscribe to the raw state and memoise in the component. See the warning at the bottom of `src/stores/theme.ts` for the historical reason.
- Avoid CDN-loaded assets. Anything needed at runtime must be bundled (Monaco is the canonical example — see `src/lib/monaco-setup.ts`).

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

Adding support for a fourth driver (MSSQL, ClickHouse, etc.) touches:

1. `Cargo.toml` — enable the relevant `sqlx` feature.
2. `src-tauri/src/state.rs` — extend the `Driver` and `DbPool` enums.
3. `src-tauri/src/db/pool.rs` — URL builder + pool constructor.
4. `src-tauri/src/db/values.rs` — row → JSON extraction.
5. `src-tauri/src/commands/schema.rs` — introspection queries.
6. `src/lib/constants.ts` and `src/components/ConnectionDialog.tsx` — default port + UI.

Open an issue first if you're planning this so we can agree on the scope.

## Security

Security-sensitive bugs should not be filed in the public issue tracker. See [SECURITY.md](SECURITY.md).
