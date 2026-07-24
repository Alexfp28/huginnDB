# HuginnDB roadmap

The single, current source of truth for "what's left." Historical per-version
planning docs (`1.4.0_ROADMAP.md`, `1.5.0_ROADMAP.md`) have been retired now
that their work has shipped — see `CHANGELOG.md` for the record of what each
release actually contained. Two living, detail-level roadmaps are still
maintained separately because they track a single subsystem in depth:

- [`docs/MONGODB_ROADMAP.md`](docs/MONGODB_ROADMAP.md) — MongoDB driver, done
  vs. deferred, with the technical hook for each deferred item.
- [`docs/MCP_CONNECTOR_ROADMAP.md`](docs/MCP_CONNECTOR_ROADMAP.md) — the
  `huginndb-mcp` connector's design rationale and phased build-out (now fully
  shipped, kept for the "why" behind its architecture).

This document covers everything else: the top-level feature roadmap that used
to live in the README.

## Shipped milestones

Not exhaustive — `CHANGELOG.md` is the authoritative, per-release record.
This is the "yes, that's actually done" list for the items that used to sit
in a roadmap and now don't:

| Item | Shipped | Notes |
| --- | --- | --- |
| SSH tunnel support | 0.7.0 | PostgreSQL/MySQL/MongoDB (single-host); see gotcha #18 for the local-port fallback behaviour. |
| Table structure editor (visual `ALTER TABLE`) | 1.0.2 | `db/ddl.rs` + `StructureEditorTab.tsx`; see `CLAUDE.md` gotcha #16. |
| Bulk row delete + multi-select in the data browser | 1.0.2 | Bulk **insert** is still open — see below. |
| MongoDB driver | 1.1.0, hardened through 1.8.0 | See `docs/MONGODB_ROADMAP.md` for the full done/deferred split. |
| Server-side users/privileges introspection | 1.4.0 | Every driver, including SQLite's explicit no-user-model empty state. |
| Native multi-window ("New window"), replacing workspaces | 1.4.0 | |
| Connection keepalive + lost-connection reconnect UX | 1.4.0 | |
| View editor (create/edit/rename/drop, live preview) | 1.10.0 | |
| MCP connector (`huginndb-mcp`) | 1.7.0 (binary) → 1.9.0 (per-connection write policy) | Read-only by default; `read-only`/`data`/`full` policy per connection, audited writes. See `docs/MCP_CONNECTOR_ROADMAP.md` and `docs/MCP.md`. |
| Canary pre-release channel | Unreleased | Side-by-side opt-in build for dogfooding against real profiles before a stable release. See `docs/CANARY.md`. |
| Reconnect-on-launch + session-level workspace layout | Unreleased | Restores live connections, focus, and pane geometry at startup. |

## Open (priority order)

1. **Bulk row insert** in the data browser. Bulk delete shipped in 1.0.2;
   inserting several rows at once (paste-from-clipboard or a multi-row draft)
   is still a one-row-at-a-time affair.
2. **Schema diff & export** — DDL extraction and a side-by-side compare
   between two schemas or two points in time. No backend or UI work started.
3. **More drivers** — Microsoft SQL Server, ClickHouse, DuckDB. Recipe for
   adding a driver is in `CONTRIBUTING.md`.
4. **Tighter CSP** for the webview. Currently `csp: null` (`tauri.conf.json`)
   because Monaco loads its workers as blobs — see `CLAUDE.md`'s architecture
   invariants for why the relaxation is considered narrow today.
5. **Automated tests, wider coverage.** Backend unit tests already cover a
   meaningful slice (`tab_state` migrations, `db::ddl`/`view_ddl` builders,
   `db::sql`, the Mongo shell parser and value coercion, `mcp::mod`, prefs,
   store — see `#[test]` in `src-tauri/src/{lib,store,prefs,tab_state,
   commands/query}.rs` and `db/{sql,ddl,view_ddl}.rs` and `db/mongo/{shell,
   values,query}.rs`). Still missing: integration tests against ephemeral
   Postgres/MySQL (`testcontainers-rs`), and any frontend test coverage
   (Playwright).
6. **Ship Linux release artifacts.** Closer to done than it looks: the
   bundler is already configured for `.deb`/`.AppImage`
   (`tauri.conf.json`'s `bundle.targets`), and the release workflow
   (`.github/workflows/release.yml`) already has the `ubuntu-22.04` matrix
   leg and its apt build-deps (`libwebkit2gtk-4.1-dev`,
   `libappindicator3-dev`, `librsvg2-dev`, `patchelf`) wired up — but that
   leg is commented out ("keeps the runtime + signing surface small for
   now"), so **no Linux binary is currently published on a GitHub
   Release**. Building from source works fine (see README Installation);
   there's just nothing to download. Next step is to uncomment the leg,
   verify a real tagged build end-to-end, and add a "From a release
   (Linux)" section to the README once artifacts exist. Only x86_64 is
   targeted today — an `aarch64`/arm64 leg, an `rpm` bundle target, and any
   distribution beyond raw GitHub Releases (Flatpak/Flathub, Snap, an AUR
   package) have zero existing scaffolding and are further-out stretch
   goals, not blocking this item.
7. **macOS bundle with code signing.** The build is expected to work but is
   unverified, and there's no Apple Developer signing/notarization yet
   (parallels the Windows SmartScreen situation documented in the README).
8. **Visual query builder** — low priority. Monaco is fast enough that most
   users probably don't want one; only pursue if there's real demand.
9. **Keyset (seek) pagination for deep table navigation** — low priority.
   The data browser paginates with `LIMIT/OFFSET` (and `.skip()` on MongoDB),
   which is O(offset): jumping deep into a multi-million-row table makes the
   engine scan and discard every skipped row. A `WHERE (sort_key) > :last`
   seek would make deep pages O(1), but it doesn't compose with "jump to page
   N" or arbitrary multi-column sort, so it's a targeted optimisation, not a
   drop-in replacement for the current offset model. Deferred deliberately:
   the Unreleased row-count decoupling + whole-table estimate (issue #77)
   already removed the *actual* first-paint stall, so the offset cost only
   bites a user who pages very deep, which is rare in practice. Revisit only
   if a real deep-navigation complaint appears.

Have a different priority? Open a
[feature request](.github/ISSUE_TEMPLATE/feature_request.md).

## Explicitly out of scope

Don't propose these unless the user asks first:

- Reorganising components into per-feature folders — flat layout is fine at
  this size.
- A linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy`
  advice in `CONTRIBUTING.md`.
- AI features baked into the app itself (autocomplete suggestions via LLM,
  "explain this query", etc.) — the MCP connector is the sanctioned way an AI
  tool touches HuginnDB, from the outside.
- Cloud sync of profiles or saved queries.
- Mobile builds — Tauri's icon CLI generated iOS/Android directories during
  scaffolding, but desktop is the only target.
