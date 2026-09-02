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
| View editor (create/edit/rename/drop, live preview) | 1.10.0 | SQL drivers. MongoDB views go through the aggregation editor instead — see the next row. |
| MongoDB aggregation editor + view editing | 1.16.0 | Stage-by-stage and text modes with live per-stage previews; "Save as view" / `collMod`. See `CLAUDE.md` gotcha #33 and `docs/MONGODB_ROADMAP.md` item #12. |
| MongoDB index manager (list, create, hide, replace, drop) | 1.16.0 | Read from raw `listIndexes` documents (not the lossy typed `IndexModel`), so any option beyond name/keys/`unique` round-trips. See `CLAUDE.md` gotcha #34 and `docs/MONGODB_ROADMAP.md` item #1. |
| JSON Schema library + per-column bindings | 1.17.0 | User-defined schemas attached to columns, driving completion, hover documentation and advisory validation in the cell editor. Global rather than per-environment, resolved by a most-specific-wins cascade that exists only in Rust. See `CLAUDE.md` gotcha #39 and `docs/JSON_SCHEMAS.md`. |
| MCP connector (`huginndb-mcp`) | 1.7.0 (binary) → 1.9.0 (per-connection write policy) → view management → MongoDB index/DDL | Read-only by default; `read-only`/`data`/`full` policy per connection, audited writes. Views are readable, editable and droppable on all five drivers at the `full` tier — no separate permission axis. MongoDB index creation/removal is reachable too (its mongosh grammar had no DDL at all before 1.19.0); SQL index and table DDL stay with `run_query`, which is more expressive than any portable form. See `docs/MCP_CONNECTOR_ROADMAP.md` and `docs/MCP.md`. |
| Canary pre-release channel | 1.11.0 | Side-by-side opt-in build for dogfooding against real profiles before a stable release. See `docs/CANARY.md`. |
| Reconnect-on-launch + session-level workspace layout | 1.11.0 | Restores live connections, focus, and pane geometry at startup. |
| Microsoft SQL Server driver | 1.13.0 | Read + edit-data MVP via `tiberius` (`sqlx` has no MSSQL driver). Structure/view editing and `.sql` export are deferred — see the CHANGELOG entry for the full list. Requires SQL Server 2012+. |
| **HuginnDB Pulse** — live server health/performance monitoring | 1.20.0 | Vital signs, top time-consuming statements (with `EXPLAIN`), storage, sessions and index usage for **MySQL and MongoDB**, docked next to the workspace or expanded into its own window; an opt-in per-connection history sampler (`pulse.db`) answers "was this slow yesterday too"; reachable over MCP through seven read-only tools. Postgres/SQLite/SQL Server show an explicit "not supported yet" state. See `docs/PULSE.md`. |

## Open (priority order)

1. **Bulk row insert** in the data browser. Bulk delete shipped in 1.0.2;
   inserting several rows at once (paste-from-clipboard or a multi-row draft)
   is still a one-row-at-a-time affair on the SQL drivers. **MongoDB is
   covered**: the free-form document dialog accepts an array and inserts it
   with `insert_many`, which falls out of the shell parser already accepting
   one. What remains is the SQL side, where a multi-row draft has no
   equivalent.
2. **Schema diff & export** — DDL extraction and a side-by-side compare
   between two schemas or two points in time. No backend or UI work started.
3. **More drivers** — ClickHouse, DuckDB. Recipe for adding a driver is in
   `CONTRIBUTING.md`. Microsoft SQL Server shipped (see above); what is left
   there is its DDL surface — the structure editor, table/view rename and
   `.sql` export/import — which needs a T-SQL builder in `db/ddl.rs`,
   `db/view_ddl.rs` and `db/dump.rs`.
4. **Cloud/managed database support (Supabase, Neon, PlanetScale, ...)** — a
   Supabase project's Postgres endpoint already connects today through the
   existing PostgreSQL driver (it's plain Postgres on the wire), so this
   isn't a new driver — it's ergonomics and pooler-awareness on top of the
   one that exists. Candidate scope: (a) a "cloud provider" connection mode
   that takes a project URL/API key instead of hand-entered host/port/user/
   password; (b) correct handling of Supabase's pgbouncer **transaction-mode**
   pooler, which doesn't support prepared statements — `sqlx`'s default
   Postgres protocol assumes them, so connecting through port 6543 needs a
   simple-query fallback or the direct-connection port documented as the
   supported path; (c) optionally surfacing project-level metadata (RLS
   policies, branches) the way the existing users/privileges panel does for
   plain Postgres. No design work started; needs scoping (Supabase-only vs.
   a generic "cloud Postgres" abstraction covering Neon/PlanetScale too)
   before implementation begins.
5. **Tighter CSP** for the webview. Currently `csp: null` (`tauri.conf.json`)
   because Monaco loads its workers as blobs — see `CLAUDE.md`'s architecture
   invariants for why the relaxation is considered narrow today.
6. **Automated tests, wider coverage.** Backend unit tests already cover a
   meaningful slice (`tab_state` migrations, `db::ddl`/`view_ddl` builders,
   `db::sql`, the Mongo shell parser/value coercion/aggregation/indexes,
   `mcp::mod`, `bridge`, prefs, store, SQL Server's pool/schema/values — see
   `#[test]` in `src-tauri/src/{lib,store,prefs,tab_state,commands/query,
   commands/origins}.rs`, `db/{sql,ddl,view_ddl,pool,endpoint}.rs`,
   `db/mongo/{shell,values,query,aggregation,indexes}.rs`, `db/mssql/{mod,
   schema,values}.rs` and `bridge/{protocol,server}.rs`). Still missing:
   integration tests against ephemeral Postgres/MySQL (`testcontainers-rs`),
   and any frontend test coverage (Playwright).
7. **Broaden Linux distribution.** The `ubuntu-22.04` leg in
   `.github/workflows/release.yml` is now **enabled**, so a tagged build
   publishes `x86_64` `.deb` + `.AppImage` alongside the Windows installer,
   and the README documents both. One caveat before treating this as closed:
   the leg has not yet been exercised by a real tagged run — use the
   workflow's `workflow_dispatch` input with a throwaway tag like
   `v0.0.0-test` to smoke-test it, then delete the draft. (The updater is
   *not* a concern: tauri-action fetches the existing `latest.json` and merges
   its own entries into `platforms` rather than replacing the asset, so the
   second leg to finish preserves the first one's entry. Its known race
   between parallel legs — tauri-apps/tauri-action#1270 — is mitigated with
   `retryAttempts: 3`; see the comment on that step.)

   **Dated follow-up: move the Linux leg to `ubuntu-24.04` before March
   2027.** `ubuntu-22.04` is GA today but retires on 2027-04-17, with
   deliberate brownouts from late March (actions/runner-images#14254). It is
   the right image *now* because it has the oldest glibc still available
   (2.35) and that maximises AppImage compatibility, so this is a deadline to
   track rather than something to do early.

   **`.rpm` target added** (Fedora/openSUSE/RHEL-family) — `bundle.targets`
   in `tauri.conf.json` now includes `"rpm"`. Tauri's rpm bundler is the pure
   Rust `rpm` crate, so it builds from the same `ubuntu-22.04` leg with no
   extra system packages or CI changes. Smoke-tested via `workflow_dispatch`
   with the `v0.0.0-test` throwaway tag (run
   [#32025472960](https://github.com/Alexfp28/huginnDB/actions/runs/32025472960)):
   both legs completed successfully and the draft release carried a valid
   `HuginnDB-1.16.0-1.x86_64.rpm` + `.sig` alongside the existing assets.
   What that confirms is that the bundler produces a well-formed package —
   it does **not** confirm the package actually installs and launches on a
   real Fedora/openSUSE box, which is still unverified.

   What genuinely remains beyond that: an `aarch64`/arm64 leg, and any
   distribution beyond raw GitHub Releases (Flatpak/Flathub, Snap, an AUR
   package) — all with zero existing scaffolding. Arch is a special case:
   the `.AppImage` already runs there unmodified (Arch's glibc is always
   newer than the `ubuntu-22.04` baseline it's built against), so "Arch
   support" doesn't need a new Tauri bundle target — it needs someone to
   write and maintain a `PKGBUILD` for the AUR, which is an external
   packaging/publishing step (an aur.archlinux.org account + SSH key), not a
   change to this repo's build.
8. **macOS bundle with code signing.** The build is expected to work but is
   unverified, and there's no Apple Developer signing/notarization yet
   (parallels the Windows SmartScreen situation documented in the README).
9. **Visual query builder** — low priority. Monaco is fast enough that most
   users probably don't want one; only pursue if there's real demand.
10. **Keyset (seek) pagination for deep table navigation** — low priority.
   The data browser paginates with `LIMIT/OFFSET` (and `.skip()` on MongoDB),
   which is O(offset): jumping deep into a multi-million-row table makes the
   engine scan and discard every skipped row. A `WHERE (sort_key) > :last`
   seek would make deep pages O(1), but it doesn't compose with "jump to page
   N" or arbitrary multi-column sort, so it's a targeted optimisation, not a
   drop-in replacement for the current offset model. Deferred deliberately:
   the 1.11.0 row-count decoupling + whole-table estimate (issue #77)
   already removed the *actual* first-paint stall, so the offset cost only
   bites a user who pages very deep, which is rare in practice. Revisit only
   if a real deep-navigation complaint appears.

## Fit and finish

A standing track, deliberately separate from the numbered list above.

**Why it needs its own section rather than a place in that queue.** The
convention for "what's next" is the top open item above, and until this section
existed every item there was a feature or a piece of infrastructure. Polish did
not lose that queue on merit — it was never in it, so the standing instruction
for what to work on was structurally incapable of surfacing one. The practical
consequence is visible in the 1.20.x history: every fix in that pass arrived
because someone using the app noticed and said so. That is a fine way to find
problems and a bad way to be the *only* way to find them.

The section is a queue, not a wishlist. An entry earns a place by naming
something observable — a file and line, a count, a reproducible behaviour — and
by falling into one of the four classes below. "The grid feels clunky" is not
an entry; the four things that make it feel clunky are.

**Cadence: each minor release closes at least two of these.** Small enough that
it never competes with a driver, regular enough that the list cannot only grow.

### The four classes

They are worth keeping apart because they fail differently, and three of the
four look like styling problems while having nothing to do with styling.

1. **Adoption debt.** A primitive already answers the question and the call
   site never migrated. Cheap, mechanical, and the only class with a machine
   count: `uiAdoption.test.ts` holds the budgets, sorted by debt, so it doubles
   as this class's worklist.
2. **Global behaviour with no owner.** A library default nobody chose, applied
   app-wide. Usually one line; the cost is that it takes a user report to find,
   because there is no file it is "missing from".
3. **State that cannot express what the UI needs to say.** Looks like a
   rendering bug and is not — no amount of styling fixes a store that does not
   hold the fact being rendered.
4. **A genuine interaction gap.** The app cannot do the thing. These are the
   only ones that are features, and they are sized like features.

### Open

**Adoption debt.** 139 raw `<button>` elements across 72 files and 81 native
`title=` attributes across 41, both counted and ratcheted by
`src/components/ui/uiAdoption.test.ts`. The budgets can only shrink, so this
entry needs no separate tracking — read the maps. **They are not all
migratable, and the target is not zero**: working `DocumentListView` established
that a real class of text-level actions sits below the primitive layer's
density floor (`IconButton`'s smallest shape is a fixed `h-6 w-6`, which inside
a monospace field row pins the height and breaks the grid's Ctrl+wheel zoom),
alongside affordances that render a glyph or a word rather than a Lucide icon.
Those are documented exceptions in the test, not work. Read the reason before
pushing a count down. Worth naming individually:

- ~~`GridToolbar.tsx:166`'s OS tooltip on the Insert button~~ — **fixed**; it
  became a `SimpleTooltip` while that button was being rebuilt as a split
  control. Worth keeping the note for the rule it exposed:
  `uiContracts.test.ts`'s rule H exists for exactly this shape and misses it,
  because it fires only on `size="icon"`. **Widening rule H is still blocked**
  — as a contract it would fail on the 79 remaining — so it stays a one-line
  change for the moment that budget empties. That ordering is the point: the
  budget is what makes the contract mergeable later.
- The heaviest single files are `DocumentListView.tsx` (6 raw buttons, 4 OS
  tooltips) and `ConnectionTreeRow.tsx` (8 OS tooltips). Both are row/list
  components, so one pass over each clears a visible share of both budgets.
- `ConnectionsTree`'s visible-databases button cannot become an `IconButton` as
  it stands: it paints a subset badge over its glyph, and `IconButton` takes
  the icon as a component with no room for a child. Either it gains a badge
  slot or this one stays hand-rolled with a written reason — the decision, not
  the migration, is the work.

**Token adoption.** The design tokens exist and are almost unused:
`brand-flash` (the "short blue pulse on a completed action" the visual brief
asked for) has **two** call sites in the whole app, and the 180/220 ms motion
band has **three** between both ends. This is the same shape as the class above
one level down — a vocabulary written and then not spoken. The work is not
"add animations": it is deciding which completions deserve confirmation at all,
then either adopting the token or deleting it. A token with two uses is not a
system.

**Discoverability of the grid's sizing gestures.** Neither "fit to content" nor
"fit to visible width" appears in `lib/keybindings/actions.ts`, so both are
mouse-only in a keyboard-first app. Adding them to `ACTIONS` also gets them
into the command palette and the settings shortcut list for free (gotcha #53),
which is most of the value.

**Class 2 and class 3 have no known open instances.** Stated rather than
omitted, because an empty class is information: the tooltip-provider default
and the environment switch target were each the only confirmed member of
theirs, and both are fixed. The connection surfaces were checked at the same
time and already model their targets correctly (`connecting: string | null`,
`disconnecting: Set<string>`); `useSchema.loading` is per-connection inside its
slice, and `useOriginSync.syncing` is a genuine batch flag over a pass that
really does sweep every origin. The classes stay in the taxonomy because they
describe how those two bugs happened and what the next one will look like, not
because there is a backlog behind them.

Have a different priority? Open a
[feature request](.github/ISSUE_TEMPLATE/feature_request.md).

## Explicitly out of scope

Don't propose these unless the user asks first:

- A linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy`
  advice in `CONTRIBUTING.md`.
- AI features baked into the app itself (autocomplete suggestions via LLM,
  "explain this query", etc.) — the MCP connector is the sanctioned way an AI
  tool touches HuginnDB, from the outside.
- Cloud sync of profiles or saved queries. **Shared origins** (#108, shipped) are
  not this and don't open the door to it: a file on a path the OS already mounts,
  curated by hand, read one way with no service, account or background upload
  behind it. HuginnDB never writes to the share.
- Mobile builds — Tauri's icon CLI generated iOS/Android directories during
  scaffolding, but desktop is the only target.
