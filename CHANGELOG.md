# Changelog

All notable changes to HuginnDB are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches `1.0`. Pre-1.0 minor releases may contain breaking changes; consult the relevant section before upgrading.

## [Unreleased]

## [1.17.0] — 2026-08-20

### Added

- **A determinate progress bar for the profile/environment import dialogs**, fed
  by a new `huginndb://import-progress` event emitted from
  `apply_profile_imports` (`src-tauri/src/commands/connection.rs`) once per
  profile as it works through the exported list. Now that the import runs off
  the main thread (see the "not responding" fix below), the window stays
  responsive during a large import, but the disabled button gave no sense of
  whether it was almost done or stuck — a real concern once the operation can
  legitimately take tens of seconds. `ImportProgressBar`
  (`src/components/connection/dialogs/`) renders "N of total" and is shared by
  both `ImportProfilesDialog` and `ImportEnvironmentDialog`, each attaching a
  scoped `listen()` for the duration of its own `doImport` call.

- **"Mark all as: …" bulk actions above the conflict list** in both import
  dialogs (`ConflictBulkActions`, `src/components/connection/dialogs/`), so
  resolving a bundle with dozens of conflicting profiles — the exact case a
  multi-environment import produces — no longer means clicking
  Rename/Overwrite/Skip on every row individually. Sets every conflict's
  resolution at once via the same `resolutions` map the per-row buttons write
  to, so nothing downstream needed to change.

- **A library of user-defined JSON Schemas, and per-column bindings that make the
  cell editor schema-aware.** A HuginnDB used as a configuration store ends up
  with `json`/`jsonb`/`TEXT` columns holding documents hundreds of lines long that
  have a real, if unwritten, contract — and the cell editor treated every one of
  them as anonymous JSON: syntax highlighting, a valid/invalid badge, and nothing
  else. You now keep a library of schemas (a name, an optional description, and
  the document exactly as you typed it, in a `json_schemas.json` of its own) plus
  a separate list of bindings saying which columns each one applies to. Attach one
  and Monaco starts completing property names, suggesting enum values, showing each
  property's `description` on hover, and underlining values that do not fit. The
  completion and the hover documentation are the part that changes a working day;
  the validation is the smaller half.

  The library is **global — not scoped to an environment**, and that is a
  deliberate reading of what a binding means. A binding says "this table's column
  looks like this", which is a fact about the *server*, not about whether you are
  looking at Production or Staging. Scoping it to an environment would give the
  same table a schema in one environment and not in another, which is the
  `visible_databases` bug (gotcha #27) a third time. It also lives in a file of its
  own rather than in `prefs.json`, because a real schema body is 50–200 KB and
  `prefs.json` is rewritten on every `Ctrl`+wheel of the grid.

- **Validation never blocks a save, by construction.** Nothing in the commit path
  reads markers, and the diagnostics are configured at warning severity so a
  violation does not even *look* like it blocks. The database is the authority; a
  schema is an aid. The day someone's schema is slightly wrong they can still edit
  their own data.

- **A most-specific-wins cascade, implemented once, in Rust.** A binding names a
  connection, a schema/database, a table and a column; every axis but the column
  may be "any", and the table and column accept a simple `*` glob, so one rule can
  cover `*_json` across a whole server or exactly one column of one table.
  Specificity runs `column > table > schema/database > connection`, and connection
  being the *lightest* axis is the counter-intuitive part that makes the motivating
  case work: a blanket rule over a whole connection must lose to a rule naming the
  exact table and column, while between two otherwise identical rules the pinned
  one should win — which is precisely what a tie-break axis is for. So a default
  schema for `configuration` everywhere plus one override on the table whose shape
  differs is two rules, not twelve. The frontend never re-derives any of this: it
  would be a second implementation of one grammar (gotchas #30/#33), and the drift
  would be silent, because a resolution bug is not an error — it is "the completion
  did not appear", which nobody reports. Resolution is one call per data tab,
  cached per relation, so the granularity rather than the language answers the
  performance question.

- **"Create from this value", because asking anyone to write a JSON Schema by hand
  has an adoption rate near zero.** The badge drafts one from the document in front
  of you: name it, review the draft, and it is created and linked without leaving
  the editor. Its rules are documented rather than magic, and two of them exist to
  stop it producing a schema that rejects the rows it was drafted from: `required`
  is the *intersection* of keys present in every sample, never the union, and an
  `enum` is only written when a value actually repeated — three distinct values
  across three rows is a sample size, not a closed domain. It always states
  `$schema`, which is load-bearing rather than decorative: without it the language
  service validates with 2020-12 semantics instead of draft-07. Output is
  byte-stable for the same input, so regenerating a schema produces a readable diff.

- **Three surfaces bind a column, in decreasing order of how often you will use
  them.** The one that matters is a **badge in the cell editor's header rail** (in
  both the modal and the docked side panel), beside the JSON-valid chip: it names
  the resolved schema, reads "no schema" in low contrast when there is none, and its
  dropdown links any library entry, drafts a new one, or unlinks. This is the
  universal surface — it is the only one MongoDB and SQL Server have. Second, a
  **new Settings → JSON Schemas section**: the library on the left, the selected
  entry's document on the right in a Monaco pane that edits in place and expands to
  fullscreen with F11 rather than stacking a second modal, and the full bindings
  table underneath in resolution order. Third, a **per-column field in the table
  structure editor**, deliberately fenced off — see *Changed* below.

- **The bindings table shows the cascade rather than listing it.** A wildcard axis
  draws the glyph `*` and never an empty cell, because an empty cell reads as "not
  filled in yet" — the most common misreading of any precedence table. Row order
  *is* precedence, since the backend returns bindings ranked. And a **"Test a
  column"** box answers the question this feature will generate most — *why is my
  rule not applying?* — through the same resolver the editor uses, so the answer
  cannot disagree with what happens while editing. A live match counter was the
  alternative and is worse: it would have to walk the catalogues of every live
  connection and would still only cover whatever happens to be connected.

- **Standalone export/import (`meta.kind = "json-schemas"`), plus opt-in inclusion
  in an environment export.** No passphrase in either case: a schema carries no
  secret and no keychain material. The interesting rule is what happens to a
  binding pinned to a *connection*, since a connection id is a uuid local to the
  machine that minted it: on import elsewhere such a binding arrives **switched
  off**, with its original scope preserved. It is not widened to "any connection"
  (that would change what the rule means) and not dropped silently (that would lose
  the intent with no way to notice) — and the import wizard states the count before
  writing anything. An environment import translates instead, through the same
  original-to-new id map `launch.visible_connections` already uses.

- **A new user guide, `docs/JSON_SCHEMAS.md`** (with its Spanish twin), in the repo
  and under Help → Documentation. It covers the 30-second route, the cascade with a
  worked two-rule example, the exact limits of the drafted schema, the sharing
  caveat, and a "what this is not" section — including the three language-service
  behaviours that are surprising enough to be support questions: a document's own
  `$schema` takes precedence over its binding, one unresolvable `$ref` stops the
  whole document being validated, and nothing is ever fetched from the network.

- **Three preferences — validation, completion and hover.** Split because the
  language service splits them: a rough schema is useful for completion long before
  anyone wants red underlines. They live in the JSON Schemas section rather than
  under Editor, the same call `AppearanceSection` already makes for the data-view
  group. Also four new command-palette actions and three jump-to-setting entries.

- **Shared origins can now publish and continuously sync a whole environment
  (#108), not just loose connections.** Until now `sync_origin` always
  assumed the file was a plain profile bundle (`meta.kind = "profiles"`);
  pointing an origin at an environment export (`meta.kind = "environment"`,
  the same file `export_environments` already writes) silently synced only
  its `profiles` and dropped every `environments` entry, since `serde_json`
  ignores unknown fields rather than erroring. `sync_origin` now reads the
  file's own declared kind and, for an environment export, reconciles a local
  mirror environment on every pull: creating it the first time, refreshing
  its name/color/icon/theme and connection membership (`launch.visible_connections`)
  on every sync after. The match across repeated syncs is by
  `(origin_id, origin_source_id)` — the publisher's own `Environment.id` at
  export time, a new field on `ExportedEnvironment` — not by name or position
  in the file, both of which can change between syncs. A mirrored environment
  is read-only in the rail/switcher (renamed/recolored/deleted only via
  adopt/retire, exactly like an origin-owned connection profile already was)
  and, if its bundle disappears from a later sync, is reported as vanished
  rather than deleted — same "report, never destroy on our own initiative"
  rule the connection side already followed. Deliberately does **not**
  auto-register the origins nested inside the bundle: a shared file must
  never be able to make a machine register more origins on its own, that
  stays reserved for the conscious, one-shot `import_environment`.

- **Column reordering in the table structure editor, MySQL only.** Up/down
  arrows next to each row (revealed on hover, next to the existing delete
  icon) let you move a column without dropping and re-adding it. Designing a
  brand-new table allows reordering on every driver — it's just column array
  order feeding one `CREATE TABLE` — but repositioning a column on a *live*
  table needs a real `ALTER`, and only MySQL's `MODIFY COLUMN`/`ADD COLUMN …
  FIRST|AFTER col` can express that; Postgres has no equivalent ALTER at all,
  and SQLite would mean forcing the 12-step rebuild for what is otherwise a
  no-op change. `db::ddl::mysql_column_positions` diffs the desired column
  order against where each surviving/new column would naturally land (an
  unmoved `MODIFY`/`ADD COLUMN` leaves a column in place / appends it at the
  end) and only emits a position clause for the columns that actually need to
  move, so an unrelated edit elsewhere in the table never gets a spurious
  reorder statement.

### Changed

- **The cell editor now gives Monaco a stable model `path`.** This was the enabling
  change for everything above: schemas attach by `fileMatch` against the model URI,
  and the auto-generated `inmemory://model/N` a bare editor gets matches nothing
  that can be registered, so no schema could apply at all. The path carries which
  surface owns it, because the modal and the docked panel can be open at once and
  two editors sharing a path share a model — whichever unmounted first would destroy
  it under the other.

- **The inline expand buttons say when a schema is attached**, rendering `{}`
  instead of the expand glyph and naming the schema in their tooltip. Double-click
  still opens the same one-line inline editor (gotcha #12 stands); only the icon and
  the tooltip changed. A one-line `<input>` cannot offer completion or validation,
  so the only useful hint is that escalating is worth it.

- **A bound column forces the editor into JSON mode**, overriding the content-type
  heuristic. That heuristic only answers "json" when the text parses, which would
  leave a momentarily-broken document with no validation at all — precisely when it
  is most useful. A binding is the user asserting the column holds JSON.

- **The table structure editor gained a per-column `{}` affordance, fenced off from
  the DDL.** A binding is local editor metadata, not a schema change: it lives in
  its own state rather than on the working column, so it cannot ride into the
  `preview_structure_change` payload or re-trigger the debounced DDL preview
  (gotcha #16). It saves the instant it is picked, sits behind a dashed divider
  under a `local` tag, and is disabled while designing a table that does not exist
  yet. Column renames are followed after a successful apply, best-effort — the DDL
  has already run, so a failure there is a toast and never a rollback.

- **`ExportEnvironmentDialog` grew an opt-in "Include JSON Schemas and their
  bindings" switch.** Schemas are global, so this packs the whole library alongside
  the environment rather than making them part of it — one file to set up a new
  machine.

- **Deleting a connection now also drops the bindings pinned to it**, reporting how
  many. A profile id is a uuid that is never reused, so such a binding can never
  match again: it is a provably dead rule rather than something inert but possibly
  meaningful, which makes it a keyed payload worth reaping (gotcha #27). The
  asymmetry is what makes that safe — the schema, the expensive artefact, is never
  touched.

- **Bulk-deleting connections, deleting an environment, and removing a
  shared origin now use a real confirm dialog instead of the native
  `window.confirm`.** The dialog for removing an origin also states up front
  how many connections and environments it published will be flagged as
  orphaned by the fix above, so "what it published stays" isn't an abstract
  warning.

- **Shared origins moved from per-environment to a global registry**
  (`tab_state.json` v5: `Environment.origins` → the top-level
  `PersistedTabState.origins`). An origin describes a server-side resource, not
  a Producción/Staging axis, and what it produces — `profiles.json` entries,
  whole mirrored environments — was already global; scoping the *registration*
  to one environment reproduced the `visible_databases` bug one level up (the
  same shared file needed a second, independent registration to be seen from a
  second environment) and meant deleting whichever environment happened to
  hold the registration silently orphaned every connection it had ever
  imported. `add/update/remove/sync/list_origins` all operate on the global
  list now; `export_environments`/`import_environment` derive an environment's
  bundled origins from what its connections (or its own mirror) actually
  depend on rather than copying a per-environment list verbatim. Existing
  installs migrate automatically: two environments that had each registered
  the same `path` independently dedupe into one global entry (first one seen
  keeps its id), and every dangling reference — a profile's `origin_id`, a
  mirrored environment's `origin_id` — is remapped to the surviving id.

- **The File menu's import/export items are now grouped under a section header
  per type** (Profiles / Environments / JSON Schemas) instead of separated by
  bare `DropdownMenuSeparator`s. With six lookalike "Import…"/"Export…" rows in
  a row, an empty separator read as "unrelated item boundary" rather than "new
  category" — reuses the same inline-header idiom `ViewMenu` already applies
  to its "Panels"/"Schema tree" groups. Import is now listed before export in
  every section (Environments and JSON Schemas were Export-then-Import; only
  Profiles already read that way). "Import environment…" is renamed "Import
  environments…" (and its dialog title/file-picker title likewise) since one
  file can bundle more than one environment, matching "Export environments…".

- **Restyled the "What's new" dialog (`WhatsNewDialog`) to match the brand
  identity, and rewrote its 1.17.0 hero line.** The dialog previously used a
  generic `Sparkles` chip and a full paragraph as the tagline; it now leads
  with the sticker mark over the halftone wash (the same device
  `AboutSection`/`EmptyState`/the splash screen use), so it repaints with
  whatever theme is active since every colour is a semantic token. The
  tagline is now one punchy sentence that says what the release is about at a
  glance, instead of a summary of every highlight. Each highlight body clamps
  to two lines with a WhatsApp-style "Read more"/"Read less" toggle
  (`HighlightBody`) — recent releases carry enough nuance that a body
  regularly runs 4-5 lines, and the toggle only renders once the clamped
  text is confirmed to overflow (`scrollHeight` vs `clientHeight`), so a
  short highlight never grows a dead button that expands to identical text.

- **The cell editor dialog's chrome (`CellEditor`) was rebuilt to match the
  rest of the app instead of a pre-branding leftover.** Its header used to be
  a second, independently bordered and shadowed card floating inside the
  dialog's own border — two nested outlines that read as pointless, and which
  pushed the dialog's built-in close button into the low-contrast gap between
  them, making the `×` nearly invisible. The header and footer are now
  edge-to-edge with a single `border-b`/`border-t`, the same convention
  `SettingsDialog` and the just-restyled `WhatsNewDialog` already use, so the
  close button sits directly on the header surface with proper contrast
  instead of floating in a seam.

- **The JSON Schema badge inside the cell editor's toolbar
  (`SchemaBindingBadge`, new `className` prop) is now a proper outline button
  pinned to the toolbar's right edge**, sharing `buttonVariants` with the
  neighbouring "Format" button instead of rendering as a tiny mono/10px pill
  that read as a stray tag rather than a control. The bound/declared states
  keep their brand/warning tint, just at button scale. The structure editor's
  inline `variant="compact"` chip (one per table row) is unchanged.

### Fixed

- **A hand-typed SELECT with no `LIMIT`/`TOP` over a large table could take
  down the whole app with an out-of-memory crash, and the "Run" button's timer
  kept spinning the entire time it happened.** Reported against SQL Server (a
  query pasted straight from SSMS over a multi-million-row table), but the
  root cause was shared by every SQL driver: `execute_query`/`execute_batch`
  (`src-tauri/src/commands/query.rs`) handed the editor's SQL straight to
  `sqlx::query(..).fetch_all(..)` for Postgres/MySQL/SQLite and to
  `tiberius`'s `simple_query(..).into_results()` for SQL Server, both of which
  buffer the *entire* result set in memory before returning a single row — and
  `DataGrid` then rendered every one of those rows into the DOM (see the
  virtualization fix below). None of this was time-bounded either: the
  elapsed-time readout next to "Run" is a cosmetic `setInterval`, not a real
  timeout, so nothing in the chain ever cancelled the driver call — the query
  ran to completion (or exhausted memory first) regardless of how long the UI
  had been sitting there. MongoDB's `find`/`aggregate` shell statements had the
  same unbounded-cursor shape.

  Every ad-hoc read path (`execute_query`, `execute_batch`, and MongoDB's
  `find`/`aggregate`) now keeps at most `MAX_ADHOC_QUERY_ROWS` (50,000) rows,
  via a new generic `fetch_capped` helper that streams a SELECT with sqlx's
  `fetch()` instead of `fetch_all()`, a new `simple_query_sets_capped` on the
  SQL Server pool that walks `tiberius`'s `QueryStream` item-by-item, and a
  `collect_capped` for Mongo cursors. Rows past the cap are still drained (SQL:
  so the pooled connection/session is left at a clean protocol boundary
  instead of mid-response — dropping the stream early would corrupt the next
  caller's query on that same connection; Mongo: the cursor is simply dropped,
  which is a supported operation) — discarded, not merely deferred, so backend
  memory stays bounded no matter how many rows the query actually matches.
  `QueryResult.truncated` reports when this happened, and the grid now shows a
  "truncated" badge in the toolbar (with a hint to add a `LIMIT`/`TOP`) instead
  of silently handing back a partial result with no indication anything was
  cut. `fetch_table_data`/`fetch_collection_data` (the paginated table/
  collection browser) are unaffected — they always apply their own
  `LIMIT`/`OFFSET` and never truncate.

  `DataGrid.tsx`'s row rendering is now backed by `@tanstack/react-virtual`
  instead of mounting one real `<tr>` per row unconditionally — the file's own
  header comment used to (incorrectly) claim rows were "virtualised by the
  browser via the parent's `overflow-auto`", which is not how `overflow-auto`
  works and is exactly what let a 50,000-row capped result still bog down the
  renderer even after the backend stopped running out of memory.

- **Removing a shared origin could leave its connections permanently stuck**
  if the in-app "keep as mine / delete" notice was missed before the app
  closed — the notice lived only in memory (`useOriginSync.vanished`), so an
  app restart lost it for good, and a connection tagged with a dangling
  `origin_id` is read-only and un-deletable in the UI with no other way to
  clear the tag. `syncAll()` now also runs a reconciliation sweep on every
  pass (launch, the 4-hourly poll, and "Sync now") that catches any profile or
  mirrored environment whose `origin_id` doesn't match a currently registered
  origin and raises the same adopt/retire notice for it, without needing the
  origin's name (it's shown as "a shared origin that no longer exists"). The
  "Sync now" button in Settings → Origins no longer disables itself when zero
  origins are registered, since this sweep is useful precisely in that state —
  right after removing the last one.

- **Re-importing connection profiles with "overwrite" no longer silently breaks
  anything keyed on the profile id.** `apply_profile_imports` mints a fresh uuid
  even when overwriting an existing profile, which nothing depended on before and so
  was invisible. With bindings in the picture it means an overwrite quietly stops
  every rule pinned to that profile from matching — no error, the completion simply
  disappears, and the delete-time sweep never fires because nothing was deleted. The
  function now returns the overwrite subset of its id map, and both callers use it to
  repoint the affected bindings.

- `EnvironmentImportAnalysis` declared a `totalProfiles` field in `src/types.ts`
  while `transfer.rs` sends `total_profiles`. Nothing read it, so nothing was broken,
  but the next person to read it would have got `undefined`.

- **The environment-import wizard crashed to a blank window on its last step, with
  "Cannot read properties of undefined (reading 'length')" in the console.** This is
  that same snake_case/camelCase mismatch one level over, except this time something
  *did* read the field: `EnvironmentImportAnalysisEntry.connection_count` and
  `ImportedEnvironment.environment_id`/`origin_ids` had no `#[serde(rename_all =
  "camelCase")]`, so they crossed the wire as-is while `src/types.ts` and
  `ImportEnvironmentDialog.tsx` were written expecting `connectionCount`/
  `environmentId`/`originIds`. The review step silently showed "undefined
  conexión(es)"; the done step's `env.originIds.length` threw outright, taking the
  whole dialog tree down with it (React has no error boundary above `FileMenu`).
  Reproduced by importing a multi-environment bundle and choosing "Omitir" for every
  conflicting profile. Both structs now carry `rename_all = "camelCase"` — the
  `EnvironmentImportResult.json_schemas` / `EnvironmentImportAnalysis.total_profiles`
  fields one level up deliberately keep snake_case (see the code comments), so this
  is not a blanket rename.

- **Removing a shared origin no longer orphans what it published forever.**
  `remove_origin` always left the connections (and now environments) it
  imported in place, tagged with a now-dangling `origin_id` — deliberately,
  so a config change never silently deletes a batch of servers someone has
  work open against. But the only mechanism that ever offers to release such
  an entry (`useOriginSync`'s vanished-notice → adopt/retire) was fed
  exclusively by `syncAll()`, which iterates the *currently registered*
  origins — and a removed origin is gone from that list before it can ever
  report anything as vanished again. The connection (or environment) stayed
  permanently read-only and permanently undeletable from the UI, with no way
  out. Removing an origin now raises the same vanished-notice immediately,
  from local state, while the origin's name is still known — reusing the
  existing decide-later flow instead of inventing a second one.

- **Importing a bundle with many encrypted connection profiles no longer
  freezes the window ("not responding" in Windows) for the whole import.**
  `import_environment` and `import_profiles` were declared as plain, non-async
  Tauri commands, which Tauri dispatches directly on the app's main thread
  rather than the async runtime's thread pool. Both call
  `apply_profile_imports`, which runs `transfer::decrypt_secret` once per
  encrypted secret — a 600 000-iteration PBKDF2-HMAC-SHA256 key derivation,
  deliberately slow, with a fresh random salt per secret so there is no shared
  derivation to cache across them. A single-profile import never surfaced
  this; importing 13 environments sharing a pool of connection profiles (22 of
  them conflicting with existing ones) meant dozens of derivations running
  serially, each costing on the order of a hundred milliseconds or more,
  blocking the main thread for long enough that Windows reported the app as
  hung. Both commands are now `async fn`, with the file read, the profile
  merge/decrypt loop, the JSON-Schema binding remap, and the tab-state write
  moved into a `tauri::async_runtime::spawn_blocking` closure — the same CPU
  cost is paid, but off the thread that pumps window messages.

- **The structure editor could reject its own DDL preview for a column
  nobody touched, on MySQL `BIT` columns specifically.** MySQL reports a
  `BIT` column's default from `information_schema` in its native `b'0'`/
  `b'1'` literal form, and the structure editor round-trips that verbatim
  into the "Default" field. `validate_structure` validated every column's
  default against a conservative allowlist (numbers, quoted strings, a
  handful of keywords) regardless of whether the user had touched it, so
  simply opening a table with a `BIT` column and editing an unrelated column
  made the whole preview/apply fail with "unsupported default expression:
  \"b'0'\"" — a comment already flagged this exact class of problem for
  Postgres's cast-style defaults (`'foo'::text`) in the `dump`/SQLite-rebuild
  path, but the structure editor's own `ALTER` path never got the same
  treatment. A column's default now only goes through the allowlist when it
  actually differs from what's on the live catalog; an unchanged default —
  in whatever dialect-native form the server reports it — is trusted as-is.

## [1.16.2] — 2026-08-19

### Added

- **Three new user guides, in the app and in the repo: Connections, MongoDB
  and SQL Server.** Help → Documentation had exactly two entries
  (Environments and the MCP connector), so most of what the app does was
  documented only in the README's feature list or not at all. The new ones
  cover, respectively: creating a connection per driver and what each one
  needs, why SSL is explicit in both directions, SSH tunnels (auth, the
  local-port fallback, host-key policy, and the two cases that can't be
  tunnelled), what "leave the database blank" actually does on each engine,
  where passwords live and what never touches disk, the connection-limit
  preferences and the per-server override, keepalive and the reconnect
  affordance, every CLI flag including the ephemeral-by-construction ad-hoc
  form, encrypted export/import with the MongoDB URI caveat, and shared
  origins with their real threat model — the `mongosh` dialect the query
  editor accepts and what it deliberately refuses, the document editor's
  path-addressing and type fidelity rules, aggregation pipelines and views
  (including why `$out`/`$merge` are refused), the index manager and why
  MongoDB is the only driver with one, renaming/moving a collection, and a
  table of what isn't implemented with the reason — and `HOST\INSTANCE`
  handling with the SQL Browser, certificate trust, Windows auth, how each
  value type is rendered (`decimal` exact, `money` through a double, `bit` as
  0/1, binary as hex), the write-side specifics visible in the Console, and
  the four surfaces still gated off.
- **`docs/README.md` as an index of the docs folder** (with its Spanish
  twin), separating user guides from internal design notes and documenting
  the four steps for adding a guide — the file, the `docs.ts` entry, the i18n
  keys, and the `vite.config.ts` `DOC_FILES` path that injects its
  last-updated date — plus the constraints of the in-app markdown renderer.
  The root README's Docs section now links it and each guide; it previously
  didn't mention `ENVIRONMENTS.md` at all.
- The in-app viewer's entries are ordered by reading order rather than
  alphabetically (Connections → Environments → MongoDB → SQL Server → MCP),
  since the dialog opens on the first one.

- **The list view can now insert a row / document.** "Insert" was hidden
  whenever the grid was in list mode, which left the mode read-mostly: you
  could edit any field of an existing document and delete it, but adding one
  meant switching back to the table view. The draft is drawn as a card pinned
  above the documents — one `key : control` line per field, using the very same
  controls the table's draft row uses (auto-PK placeholder, FK combobox, BIT
  0/1 selector, plain input), now extracted into a shared `DraftCellControl` so
  the two surfaces can't drift on the details that matter (a BIT column has to
  emit the numeric string the backend's `CAST` expects, gotcha #15). It commits
  through the same `insert_row` call: switching view mode changes how the draft
  is drawn, never what it writes. Two deliberate differences from the table's
  row: focus leaving the card does **not** commit (a card is a form, and it
  hosts a type picker whose popover lives outside it — a blur-commit would fire
  the INSERT the moment that picker opened), so Enter or "Save" commits and Esc
  or "✕" discards; and on MongoDB each field carries its own **BSON type
  picker**, sent as `insert_row`'s type hint. That last part is the point of
  doing it here rather than reusing the table's fixed-type row: a collection has
  no schema, so the type a new field is stored with is a choice, and inferring
  it from the text would write an `Int32` into a field the collection holds as a
  `Long` — the fidelity trap gotcha #29 documents for edits, one step earlier.
  The field set is still the result's column list (on MongoDB, the top-level
  keys of the current page); extra fields are added to the new document with the
  per-document `+` once it exists.

### Fixed

- **`docs/MCP.es.md` was missing the whole "Connection footprint" section**,
  including "Sharing the app's pools", and its intro still said the connector
  _cannot_ share the desktop app's pools — which stopped being true when the
  `Share pools with the MCP connector` preference landed. Both are now in sync
  with the English original.

- **SQL Server: negative `decimal`/`numeric` values rendered as a
  malformed string** (`-18.900000000` came back as `-18.-900000000`).
  `tiberius`'s `Display for Numeric` formats the integer and fractional
  halves separately — `write!(f, "{}.{:0pad$}", n.int_part(), n.dec_part())`
  — and both are derived from the same signed `i128` mantissa, so a negative
  value emits its sign twice _and_ loses the zero-padding of the fractional
  part in the same breath: `-18.09` came out as `-18.-9`, `-0.000000001` as
  `0.-00000001`, and a value below 1 lost the sign entirely (`-0.5` → `0.-5`,
  because `int_part()` of it is `0`). A `decimal(18,0)` also grew a spurious
  `.0` tail. `mssql_value` now formats these columns itself from the raw
  mantissa and scale (`numeric_to_string`) instead of calling `to_string()`:
  sign taken off once, magnitude zero-padded to at least `scale + 1` digits,
  split `scale` digits from the right — no `f64` step anywhere, which is the
  whole reason these columns travel as text. Affected every consumer of a
  negative decimal equally: the data grid, CSV/JSON copy-and-export, and the
  `huginndb-mcp` connector, where it was reported. `first_i64` (the
  `COUNT(*)`/row-estimate path) stopped round-tripping through the same
  broken string too — it reads `int_part()` directly, since the rendered form
  of any non-zero scale is not something `parse::<i64>` accepts.

- **A pending insert row appeared and vanished instantly when started from a
  menu.** Reported as "the draft row flashes and is gone"; the toolbar's
  "Insert" button worked, both menu entries (the row's right-click menu and the
  toolbar's overflow menu, which is where the button moves on a narrow pane)
  did not. Both of those are Radix menus, and Radix's `FocusScope` restores
  focus to whatever was focused before the menu opened from inside its own
  `setTimeout(…, 0)` on unmount. The grid focused the draft's first cell in a
  `requestAnimationFrame`, which fired *before* that timeout — so Radix pulled
  focus straight back out of the just-mounted row, the row's focus-leave
  handler ran, and a draft nobody has typed into is silently cancelled (by
  design: it would otherwise send an `INSERT () VALUES ()`). The focus is now
  granted in a `setTimeout` chained *after* the frame, which is always queued
  after Radix's, so the draft keeps focus whichever way the two callbacks
  interleave. The frame is still what waits for the row to mount.

- **Enter or Escape inside an FK value picker committed or discarded the whole
  draft.** The draft binds Enter to "insert this row" and Escape to "discard
  it" at the row level, and `FkCombobox` called `preventDefault` on the keys it
  handles but never `stopPropagation` — so opening the picker with Enter fired
  the INSERT with a half-filled row, and closing it with Escape threw the draft
  away. Both handlers (the trigger and the panel's search field) now stop the
  event at the combobox, which is the only component that has consumed it.

- **The list view's empty state was the one empty screen with no branding.** A
  collection or table with no rows rendered a bare grey "No rows" line, while
  the table view has shown the shared `EmptyState` frame — halftone wash,
  medallion, the sticker mark with a per-state glyph — since the brand pass.
  The list view now uses the same frame (and so does an aggregation preview
  whose pipeline returned nothing), suppressed while an insert card is open:
  the surface is no longer empty, it is a form.

### Changed

- **`docs/MCP.md` (+ the Spanish twin) now documents the two independent
  approval gates a write passes through**, after a report of a connection set
  to `full` whose schema change was still refused — by the AI client, not by
  the connector. New "When the client blocks the call, not the connector"
  subsection: a table for telling a connector refusal (a tool result naming
  the policy, plus a line in `mcp-audit.log`) from a client-side block (the
  call never reaches the connector, so the audit log stays silent), why
  Claude Code's auto-mode classifier treats DDL against a live server as a
  migration against unrecognised infrastructure by default, and the four
  client-side remedies — a one-off retry from `/permissions`, a specific
  request (explicit intent clears the classifier's soft blocks), a
  `permissions.allow` rule for the tool, or `autoMode.environment` /
  `autoMode.allow` entries describing the instance. All of them belong to
  whoever runs the client; documenting them does not loosen the connector,
  whose own policy still applies after the client approves the call.

- **`docs/MCP_CONNECTOR_ROADMAP.md`: an open section on distributing the
  connector through a marketplace instead of a per-machine install.** Records
  the three candidate routes and their verdicts — the claude.ai connector
  directory is not viable (it lists _remote_ servers, and this one reads
  `profiles.json`, the OS keychain and the user's own network), while the
  Claude Code plugin marketplace and a Claude Desktop `.mcpb` extension both
  are — plus the constraint they share (neither can bundle a per-target
  compiled sidecar, so both need a launcher that resolves the installed one)
  and the two prerequisites worth doing regardless: moving the exposed-profile
  list out of `--connections` into HuginnDB's own state, and declaring
  `_meta["anthropic/requiresUserInteraction"]` on the write tools. Also states
  plainly why "the marketplace governs permissions better" narrows to a
  distribution question: approval already belongs entirely to the client, and
  the write policy is a second, server-side ceiling applied after it.

## [1.16.1] — 2026-08-18

### Added

- **Export/import one or more environments as a self-contained bundle.**
  File → "Export environments…" opens a checklist (default: everything
  selected) that writes a single JSON file with each picked environment's
  name/colour/theme, its registered shared origins (name + path only — never
  a passphrase, matching `origins.rs`'s existing threat model of keeping the
  secret out-of-band), and one deduplicated pool of the connection profiles
  any of them reference (a connection shared by two selected environments is
  written once, not duplicated). The same dialog also opens pre-checked to
  just one row from a shortcut in `EnvironmentSwitcher`. File → "Import
  environment…" reads one of these files back and **always creates brand-new
  environments** — one per bundle in the file, never merged into or
  overwritten on top of ones that already exist, so a colleague's exported
  environments can never collide with your own origins, connections, or
  environment list. Deliberately excluded: tabs, dockview geometry and
  launch state, which are session artifacts tied to the machine that
  produced them (see gotcha #10) rather than part of an environment's
  portable identity. Each new environment's connections tree is scoped to
  exactly its own imported profiles via the existing `visible_connections`
  filter (#107), and none of them are auto-connected. Connection-profile
  conflicts are resolved once for the whole file, reusing
  `import_profiles`'s exact conflict-resolution UI (overwrite/skip/rename);
  an imported encrypted origin surfaces the same "no passphrase stored"
  state a freshly-added one does, resolved on the next sync.
- **`.rpm` bundle target**, alongside the existing `.deb`/`.AppImage`, for
  Fedora/openSUSE/RHEL-family distros. Tauri's rpm bundler (the `rpm` crate)
  is pure Rust — no `rpmbuild` or extra system packages — so it builds from
  the same `ubuntu-22.04` release leg with no CI changes beyond the
  `tauri.conf.json` target list. Added `bundle.license: "MIT"` alongside it,
  since an unset License header on an RPM package reads as "Unspecified."
  Smoke-tested via `workflow_dispatch` with the `v0.0.0-test` throwaway tag
  (run #62): both legs completed and the draft release carried a valid
  `HuginnDB-1.16.0-1.x86_64.rpm` alongside the usual assets. That confirms
  the bundler output is well-formed — actual install/launch on a real
  Fedora/openSUSE box is still unverified (see `ROADMAP.md` item 7).
- **Rename a MongoDB collection**, optionally moving it into another database
  in the same operation. `renameCollection` is a run-command on the `admin`
  database that qualifies both sides with a database name, so the move comes
  free with the rename — there is no separate "move" operation to build. The
  entry sits in the collection's context menu next to Empty/Drop, and the
  rename dialog grows a destination-database picker (MongoDB only) with a
  warning that a cross-database move copies the documents server-side and
  needs privileges on both databases. `dropTarget` is always `false`: renaming
  onto an existing collection is an error the user sees, never a silent drop
  of whatever was there. Views are refused up front with a message that says
  what to do instead — MongoDB has no rename for a view, only drop + recreate,
  which is why the view editor has never offered one either. Rename is now
  gated by its own `supportsRenameTable` capability rather than by
  `supportsDdlEditing`: it needs no DDL builder, which is exactly why MongoDB
  can have it while structure editing stays read-only there.
- **A dedicated "Refresh schema" shortcut** (default `Ctrl+Shift+R`),
  rebindable alongside the others in Settings → Shortcuts. `F5` still
  refreshes the active grid's rows; this one re-reads the catalog.

### Fixed

- **"Refresh" now reloads the database you are actually looking at.** On a
  multi-DB connection the tables live in the synthetic `<parent>::db::<db>`
  child slices, but the Database node's menu, the connection row's menu and
  the command palette all refreshed the _parent_ id — re-fetching a table list
  nobody renders (on MySQL the parent pool has no database selected at all, so
  it is legitimately empty) and leaving the visible subtree untouched. A table
  created outside the app never appeared no matter how many times Refresh was
  clicked. The new `useSchema.refreshTree` refreshes a connection together
  with every per-database view opened beneath it, and the Database node
  refreshes its own child explicitly.
- **A refresh now invalidates cached columns and indexes.** It only ever
  re-fetched the database and table lists, spreading the rest of the slice
  through untouched — and since the explorer deliberately only loads a table's
  columns when they are _absent_ (so collapsing and re-expanding doesn't
  re-query), a column added outside the app stayed invisible until the
  connection was dropped. Expanded tables are re-loaded immediately after the
  wipe, so an open node comes back with its current columns.
- **SQL Server: `SERVER\INSTANCE` is accepted, in either field.** SSMS has
  a single "Server name" box and splits the combined form itself; HuginnDB
  split nothing, so pasting it into the instance field produced a SQL Browser
  lookup that could never match (the Browser only reports the bare instance
  name) and pasting it into the host field failed DNS resolution with an error
  that never mentioned instances. Both fields now normalise through
  `split_instance`, on the backend (authoritative — it also covers the CLI and
  the MCP connector) and in the connection dialog on blur, so the user sees
  the split rather than having it happen silently.
- **SQL Server: a stopped or firewalled SQL Browser no longer blocks a named
  instance with a static port.** UDP 1434 is a separate service from the
  instance's own TCP port; when the Browser doesn't answer, the port typed in
  the dialog is now tried before giving up, and a failure reports both causes
  instead of only the last one. A port left at the default 1433 is
  deliberately not treated as a static-port hint.
- **SQL Server: the "named instance cannot be tunnelled" refusal is raised
  before the SSH tunnel is opened**, instead of after paying for the handshake.

- **Clicking a table row in the schema tree almost anywhere but its name
  expanded the column preview instead of opening the table.** `TableRow`
  wrapped the whole row — chevron, icon, name, "open in tab" dot and metric
  badge — in a single button that toggled the column list, with only the
  name `<span>` carved out via `stopPropagation` to open a tab instead. Every
  IDE this project takes cues from binds a plain click on the row to opening
  it, so aiming for the row and landing a pixel outside that narrow name
  span kept surprising users with an unwanted expand/collapse. The row now
  renders two sibling buttons: a dedicated chevron-only button that toggles
  the columns (with `schema.expandColumns`/`schema.collapseColumns`
  aria-labels, en/es), and a second button covering everything else that
  opens the table tab.

## [1.16.0] — 2026-08-17

### Added

- **MongoDB indexes can be inspected and edited, from a dedicated index
  manager.** They were visible but untouchable: the structure tab listed them
  read-only, `apply_structure_change` rejects MongoDB, and the query editor's
  statement parser has never known `createIndex`. Managing an index meant
  leaving HuginnDB for `mongosh`. **Indexes…** on any collection now opens a
  tab listing the real catalogue, with create, hide, replace and drop.
  - **The list is a tool, not a catalogue.** Alongside the keys and their
    properties it shows each index's **size** and how many operations it has
    served since the counter was last reset. An index with months of uptime and
    zero uses is one nobody queries and every write pays to maintain — the most
    useful thing this view can tell you, and the reason it isn't just a list of
    names. Both columns come from `$collStats` / `$indexStats`, which need their
    own privileges, so they are omitted rather than shown as zeros when the
    connection's role can't read them.
  - **Hide sits next to drop, deliberately.** A hidden index is ignored by the
    query planner while the server keeps it up to date, so the effect of
    removing one can be measured and undone instantly. Dropping a large index
    and changing your mind costs a full rebuild.
  - Creating covers the keys (per-key direction or type, through a picker, with
    a raw-text mode for anything exotic), `unique`, `sparse`, `hidden`, TTL,
    partial filter expressions, collations, text weights and a merge-anything
    escape hatch for options the form has no field for. **Editing is a drop
    plus a create** — MongoDB cannot alter an index in place — which the dialog
    states and a confirmation repeats before it runs.
  - **Nothing the server reports is dropped in silence.** The catalogue is read
    from the raw `listIndexes` documents rather than through the driver's typed
    `IndexModel`, which keeps only names, field names and `unique`; every option
    beyond those — including ones a future server adds — survives to the editor
    and back. Reusing that typed shape would have rebuilt `{ createdAt: -1 }`
    ascending the first time anyone corrected a typo in it.
  - `_id_` is refused for drop, hide and replace by the backend, not merely
    greyed out.

- **MongoDB views are editable, through a Compass-style aggregation editor.**
  Until now a MongoDB view could be browsed but not changed: `commands/view.rs`
  rejects MongoDB on purpose, because a Mongo "view" has no `CREATE VIEW` body
  to diff — it is a stored aggregation pipeline over a source collection
  (`{create|collMod, viewOn, pipeline}`). The new aggregation editor is the
  parallel surface, and it opens two ways: **New aggregation…** on any
  collection (a scratch pipeline, which "Save as view" turns into a real view),
  and **Edit pipeline…** on any view (its pipeline loaded, saving runs
  `collMod`). Dropping a Mongo view also works now — `drop_view` grew a Mongo
  arm, since that one operation needs no DDL at all.
  - **Two modes over one pipeline.** _Stages_ gives each stage its own card
    with its own output — the pipeline truncated after that stage — which is
    what makes a sixteen-stage `$lookup` chain readable instead of one opaque
    result. _Text_ is the whole array in a single editor with the pipeline's
    output beside it. Switching between them is a conversion routed through the
    backend (`format_mongo_pipeline`), because splitting an array literal into
    stages needs the grammar and a stage body is full of commas.
  - **The stage rail is a health strip, not a breadcrumb.** Every stage is a
    chip, in order, carrying the number of documents it emitted in the sample
    (`10+` when the sample hit its limit). Read left to right it shows where a
    pipeline's data dies: the `$match` that empties everything downstream takes
    a `warning` accent at zero, an errored stage a `destructive` one.
  - Stages can be switched off without being deleted (they stay in the document
    and out of every request, and are never written into a saved view),
    reordered by dragging, collapsed, and re-typed through the stage picker —
    which replaces the body only when it is still an untouched snippet, and
    otherwise rewrites just the operator key so a mis-click costs one undo.
  - **Export pipeline** copies the enabled stages as a `mongosh` call, the bare
    pipeline, or a `db.createView(…)` snippet — the last being what a pipeline
    turns into once it stops being an exploration.
  - Pipelines are written in the same relaxed grammar the query editor already
    speaks (unquoted keys, single quotes, `ObjectId(…)`/`ISODate(…)`, and now
    `//` and `/* */` comments), parsed by that one parser in Rust — the
    frontend never parses a pipeline. Reading a view back renders its stored
    BSON as that same source (`bson_to_shell_text`), so an `ObjectId` in a
    `$match` stays an `ObjectId` and a `NumberLong` stays a `NumberLong`
    across an open-and-save round trip, rather than degrading to a string or
    an `Int32` that silently stops matching.
  - `$out` and `$merge` are refused before anything reaches the server: the
    editor previews on a debounce as you type, and a "preview" that overwrites
    a collection mid-edit is not one. Every preview is bounded by a `$limit`
    (10 documents by default, selectable up to 50).
  - A new Monaco language colours the two things that carry meaning in a
    pipeline apart — an operator key (`$match`, `$sum`) reads as a keyword, a
    field reference (`"$customerId"`, `"$$NOW"`) as a predefined name — with
    completions for stages, expression operators and BSON constructors. It
    uses the token names every theme already styles, so custom themes colour
    pipelines without knowing it exists.

### Changed

- **Every built-in theme now ships as a light/dark pair, and the roster was
  trimmed and rebalanced accordingly.** Removed `Dim` and `Solarized Dark` —
  both were single-mode presets nobody could toggle out of without landing on
  a HuginnDB default (see the Fixed entry below), and neither had enough of
  an identity to justify building a counterpart for. Added `Summer Dark` (a
  night-beach palette keeping Summer's coral/teal hues, brightened for a dark
  surface, the same way Claude Dark brightens Claude Light's terracotta),
  `Neon Light` (the lab-on-paper counterpart to Neon's near-black palette —
  every saturated hue deepens to stay legible on a bright surface, but the
  green primary/brand, cyan `fk`, yellow `pk`/`numeric` and hot-pink
  `destructive` keep the family recognisable), and `High Contrast Light` (the
  same maximum-contrast idiom inverted to white/black, keeping the identical
  signal yellow for primary/brand/ring). Ten built-in themes in total now:
  HuginnDB, Claude, Summer, Neon, and High Contrast, each with a light/dark
  pair.
  - The Appearance settings page's 26-colour editor was a single flat
    2-column grid in declaration order — unrelated tokens (say, `border` next
    to `input`, three rows after `brandHover`) sitting side by side with no
    visual grouping. It's now split into four labelled sections — Surfaces,
    Actions & brand, Status colours, Borders & focus — via a new
    `COLOR_GROUPS` export in `lib/themes.ts`, so a background/foreground pair
    and its siblings read together instead of being found by scrolling.
- **The whole interface now follows the HuginnDB brand visual language.** The
  logo's world — soft black outlines, rounded corners, light volume, one
  electric blue — is applied as a _contained_ layer over the existing
  keyboard-first tool: the working surfaces (grid, SQL, JSON) stay quiet, and
  the personality shows up in affordances, states and empty screens.
  - The two default themes were repainted on the brand palette: a slate/navy
    ramp in four depth levels (`#020617` → `#0b1220` → `#111827` → `#1e293b`)
    under a single `#2563eb` accent in dark, and white → `#f8fafc` → `#eef5ff`
    over `#d6e4f5` borders in light. The other presets (Dim, Solarized, Claude,
    Neon, Summer, High Contrast) are untouched.
  - New `brand-hover` theme token: the accent under the pointer is now a real
    colour per theme (lighter in dark themes, deeper in light ones) instead of
    `brand/90`, which faded the accent into the surface exactly when it should
    light up. It is editable like any other colour in Preferences → Appearance.
  - Buttons: 12px corners, a 2px edge on the filled variants, and a hover that
    lifts 1px into a short brand glow. Inputs, textareas and selects share one
    clean focus treatment — the border turns brand blue with a soft 3px halo,
    replacing the detached offset ring.
  - Menus, popovers, tooltips, selects and dialogs now open with the same
    fade + 98→100% scale inside the 150–220ms motion band, and sit on the
    shared elevation ramp instead of ad-hoc shadows.
  - Panel drag-and-drop targets, the active sash and a checked switch are blue
    (they are affordances); toast edges are colour-coded per outcome at one
    shared weight, with success finally green and warning theme-aware instead
    of a hard-coded amber.
  - The activity bar and the environment rail now mark the active entry with a
    4px rounded bar flush against the rail edge (brand blue in the activity
    bar, the environment's own colour in the rail) and tint the selected icon
    blue. Both rails and the chrome footer buttons gained keyboard focus rings.
  - The selected connection in the tree carries the same blue rail the active
    table row already had, plus a hairline blue edge; connection cards in the
    launcher lift 1px on hover and the active one sits inside a subtle blue
    glow.
  - Data grid: headers are semibold on a slightly elevated surface, and every
    cell separator now comes from the `border` token instead of a flat
    foreground alpha — a softer, theme-aware hairline. Column resizing (handle,
    hover, in-progress column) is blue like every other affordance.
  - **New "HuginnDB Dark" / "HuginnDB Light" editor themes** (Preferences →
    Editor), painted in the app palette: the editor background matches the
    panel exactly, the active line is a soft blue lift with Monaco's default
    box border suppressed, keywords take the brand blue and numbers the same
    amber the grid uses for numeric cells. `huginn-dark` is the new default for
    fresh installs; an install that already picked an editor theme keeps it.
  - The cell editor's header is now a rounded, slightly elevated rail with an
    icon for the detected content type, and fullscreen is a small sticker chip
    that finally shows its own shortcut (F11) instead of an anonymous icon.
  - **Empty screens are a family now**, not four unrelated grey lines: one
    shared frame (`EmptyState`) with a halftone wash, an outlined medallion
    holding the glyph and room for a hint, adopted by the connections tree, the
    console, saved queries and an empty result set. The medallion is the slot
    the sticker illustration drops into later.
  - **The new comic logo replaces the old raven/rune mark everywhere**: every
    app/installer icon size was regenerated from it (Windows, macOS, Linux,
    plus the Android/iOS sets), the empty workspace shows the full lockup, the
    About card leads with the mark over a halftone wash, empty states show it in
    their medallion with the per-state glyph as a corner badge (over a dot field
    that now spans the whole surface, lit by a blue bloom under the mark), and
    the dev browser tab finally has a favicon. Masters live in the new `brand/`
    directory, outside `public/` so 2.5MB of source artwork stays out of every
    installer; `public/image/` keeps only what the app renders, at the size it
    renders it.
  - The Windows icon was rebuilt for small sizes: the artwork is cropped to its
    own content (the master's transparent margin was costing ~10% of every
    canvas), every size is resampled by repeated 2:1 halvings with a light
    unsharp pass at 32px and below, and `icon.ico` now carries the full ladder
    — 16/20/24/32/40/48/64/96/128/256 — including the 20px and 40px entries
    Windows asks for at 125% and 250% display scaling and used to have to
    improvise by rescaling a neighbour. The "H" stays readable in the title bar,
    the taskbar and Explorer instead of turning into a blue smudge.
  - **New launch splash**: the mark over a halftone wash and a blue bloom, on
    screen for about half a second and then gone. It is an overlay inside the
    existing window, not a second Tauri window, and it never blocks or waits on
    session restore.
  - Microdetails: resize handles are rounded and turn blue while grabbed;
    connection state dots carry a soft halo of their own colour (the lit dots on
    the logo's cylinder); jumping to a preference from the command palette
    pulses it blue once before settling into its ring; the two state banners
    that used a lighter border than the rest now match.

### Fixed

- **Toggling light/dark mode on a built-in theme other than the two HuginnDB
  defaults reset it to `HuginnDB Dark`/`HuginnDB Light` instead of switching
  to that theme's own counterpart (issue #132).** `setActiveMode` looked up
  the target with `BUILT_IN_THEMES.find(t => t.id === mode)` — a literal
  match against the _mode string_ `"dark"`/`"light"`, which only ever
  resolved to the two themes whose `id` happens to equal their mode. Every
  other preset (Claude, Dim, Solarized Dark, Neon, Summer, High Contrast) hit
  no match, silently fell through to a dead branch that mutated `mode` on a
  theme never actually written back to `customThemes`, and the toolbar's
  dark/light select simply landed the user on whichever HuginnDB default
  matched the target mode. Fixed by giving every built-in theme an explicit
  `pairId` pointing at its light/dark counterpart (`lib/themes.ts`) and
  having `setActiveMode` resolve through it instead of guessing from the mode
  string. This is also why every built-in now needs a real counterpart — see
  the Changed entry above.
- **Replacing an app icon no longer leaves the old one embedded in the
  binary.** `tauri_build::build()` declares only `tauri.conf.json` and
  `capabilities/` as build inputs, and cargo tracks _only_ what a build script
  declares — so changing `icons/*` left the crate looking fresh while both
  compile-time copies of the icon (the executable's Win32 resource and the
  generated context's `default_window_icon`) kept the previous artwork, with no
  error and nothing a frontend rebuild could fix. `build.rs` now declares the
  six icon files, so touching one forces the relink.
- The active-environment marker in the left rail was never visible: it was
  offset 8px outside a full-width button, which put it beyond the shell's
  `overflow-hidden` boundary. The read-only rail button secondary windows
  render carried the same bug and is fixed with it.

- **A secondary "New window" showed every saved connection from every
  environment, with no rail to tell them apart.** `EnvironmentRail` and
  `EnvironmentSwitcher` already hid themselves outside the main window
  (gotcha #8 — only main writes `tab_state.json`), but nothing filled in the
  connection/database visibility filters (`useUi.visibleConnections` /
  `databaseVisibility` / `collapsedConnections`) for a secondary window
  either, since `restoreSession`/`switchTo` were both hard-gated to the main
  window. Because connection profiles are global, not partitioned per
  environment, the tree fell back to its "no filter" default: show
  everything. `list_environments` already returns every environment's full
  `launch` snapshot, read-only, so the fix stays on the frontend:
  `useEnvironments.load()` now seeds a secondary window's own filters from
  whichever environment is active, and `switchTo()` gained a real branch for
  non-main windows that re-points those filters locally — never touching
  `set_active_environment`, pools, tabs or `tab_state.json`. Each window
  already has its own JS process and its own Zustand store, so this can't
  leak between windows. `EnvironmentRail`/`EnvironmentSwitcher` now render in
  every window, with create/rename/delete/reorder (the actions that do write
  the shared file) hidden outside main — so several windows can each sit in a
  different environment at once, independently.

- **Switching a table's row layout (table/list) in one window silently
  switched it in every other open window and tab too.** The toggle wrote
  `documentViewMode`, a field inside the single `Preferences` blob the
  backend intentionally broadcasts to every window on save (most of
  `Preferences` genuinely is app-wide, e.g. row height). Moved it onto each
  table tab's own view state (`TabViewState`/`PersistedTab`), the same
  mechanism already used for a tab's filters/sort/search — a tab now owns its
  row layout independently of other tabs and other windows, seeded once from
  the (unchanged) global default the first time it's opened.

- **The environment rail scrolls, and Theme/Settings stay reachable.** The rail
  was one flat column with its footer pinned by `mt-auto`, which only pins
  while there is free space. At around eight or nine environments the avatars
  filled the rail, pushed the theme toggle and the settings button past its
  bottom edge, and the shell's `overflow-hidden` clipped them away — with no
  scroll to reach them and no cue that anything had been lost. The environments
  now scroll in their own container, and "+", Theme and Settings sit in a
  pinned strip below it. "+" moved out of the scrolling list on purpose:
  creating an environment shouldn't mean scrolling past every environment you
  already have.

- **A multi-database connection stopped browsing after a few idle minutes,
  even though the tree still showed it as connected.** Expanding a database on
  a server-style connection (Postgres/MySQL/SQL Server with no fixed
  `database`) opens a synthetic per-database pool
  (`<parent>::db::<database>`), and since 1.13.0 an idle one of those is closed
  by the background reaper after `connections.childIdleTtlSecs` (default 5
  minutes) — deliberately, to stop a long session's connection footprint from
  only ever growing. What wasn't accounted for is that the _parent_ connection
  the tree actually reflects stays healthy the whole time (its own heartbeat
  keeps succeeding), so the tree kept reporting "connected" while the child
  pool the next click actually needed was already gone — surfacing as either a
  `not connected: <id>` error, or, when the click only triggered the column
  list, an indefinite loading skeleton (the store's `loadColumns`/`loadIndexes`
  had no error handling, so a rejected call just left it stuck). Every command
  that resolves a connection id now transparently reopens a reaped child pool
  first, with the same cached credentials it used the first time, before the
  usual lookup — the reap itself is unchanged, only its effect on the next
  click is. Read-only metadata calls (`list_tables`, `list_columns`, the
  keepalive ping, …) also gained a 20-second timeout, so a socket a NAT or
  firewall silently half-closed fails fast instead of hanging — previously the
  only timeout anywhere in the backend guarded pool shutdown, not queries. SQL
  Server needed one more fix underneath this: a query cancelled by that new
  timeout could otherwise be handed back to the pool as healthy with its TDS
  stream left mid-read: a session is now only returned to the idle pool once
  its result has actually been classified as leaving the stream at a clean
  boundary, never on a cancelled future.
- **The `huginndb-mcp` connector could fail an otherwise-successful call with
  `invalid input: empty reply`, most visibly against SQL Server.** The bug is
  in the local bridge the sidecar uses to reuse the desktop app's own pools:
  every tool call opens with an `EnsureConnected` round trip whose success
  value is `Value::Null`, and the wire format wrapped a reply's payload in a
  bare `Option<Value>` — which `serde_json` collapses to "absent" for _any_
  `null`, regardless of what it's wrapping. A legitimate `Value::Null` success
  was therefore indistinguishable from no reply at all. The bug is agnostic to
  driver — it can hit the first call of any tool against any connection while
  the bridge is active — but SQL Server was the one place it got noticed,
  likely because other drivers were exercised with the sidecar in its
  standalone (no-bridge) mode, where this code path never runs. The payload is
  now wrapped one level deeper so the wire can tell "a null value" from "no
  value" apart; the bridge's protocol version is bumped accordingly so an old
  sidecar a client kept alive across an app update degrades to its local-pool
  fallback instead of misparsing the new shape mid-call.

## [1.15.0] — 2026-08-14

### Added

- **Environments can carry a custom avatar image.** Until now an environment
  was always drawn as its initials over the accent colour, which stops
  disambiguating as soon as two of them start with the same letter ("Cliente A"
  / "Cliente B") — exactly the case the rail exists to make glanceable. The
  create/rename dialog now takes an image: pick one through the native file
  dialog, or drop a file straight onto the avatar preview. It replaces the
  initials in the rail, the workspace picker and the dialog preview, and the
  status-bar switcher shows it too instead of its colour dot (an image is
  recognisable at 12px, which is why initials never were there). Clearing it
  goes back to the initials tile.
  Where it is stored: inline in the existing `Environment.icon` field — a
  `data:` URL, so no backend schema change and no data migration. Whatever the
  user picks is centre-cropped square and re-encoded at 128px (WebP where the
  webview can encode it, PNG otherwise) before being stored, which keeps the
  payload in the low single-digit KB: `icon` round-trips through
  `tab_state.json` on every environment write, so a full-resolution photo there
  would bloat a file the app rewrites constantly. Keeping the image inline
  rather than as a file under the config dir means it has no lifecycle of its
  own — it is copied, discarded and written with the environment itself, so
  there are no orphans to sweep and no second failure mode where the JSON
  points at a file that is gone.
  `icon` is the slot the old lucide icon picker used to write, and an
  environment that still holds a legacy icon key falls back to the initials
  exactly as it has since that picker was removed: the image branch is gated on
  the value being a `data:image/` URL, not on the field being non-empty.
  One new backend command (`read_image_data_url`) does the reading, because the
  native picker hands back a _path_ the webview cannot open itself. It
  validates the format from the file's magic bytes rather than its extension
  and refuses anything over 12 MB, so an unusable file is rejected with a clear
  message instead of turning into a data URL no `<img>` will load. The drop
  path never touches it — the browser already has the bytes.

- **Linux release artifacts are now published.** Every release already _could_
  have shipped them: `tauri.conf.json`'s `bundle.targets` has listed `deb` and
  `appimage` since 1.7.0, and `.github/workflows/release.yml` carried both the
  `ubuntu-22.04` matrix leg and its apt build-deps
  (`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
  `patchelf`). The leg was just commented out, so nothing was ever built and
  Linux users had to compile from source — the README even said so. It is now
  enabled, and a tagged build attaches `x86_64` `.deb` + `.AppImage` next to
  the Windows installer, with a new "From a release (Linux)" section in the
  README covering both. `ubuntu-22.04` is a deliberate choice over
  `ubuntu-latest`: an AppImage links against the glibc of whatever machine
  built it, so building on a newer image would silently narrow the range of
  distros the artifact can start on. The matrix already sets
  `fail-fast: false`, so a Linux-leg failure cannot take the Windows artifacts
  down with it, and the `tauri-action` step gained `retryAttempts: 3` because
  two legs now publish updater artifacts to one release: the action merges
  each platform's entry into the existing `latest.json` rather than replacing
  the asset, so no entry is lost, but parallel legs can race on the delete —
  retrying the whole fetch-merge-upload is the upstream-intended mitigation.
  Not yet exercised by a real tagged run — the workflow's `workflow_dispatch`
  input builds a draft against a throwaway tag for exactly this kind of smoke
  test.

### Changed

- **The environment label in the left rail is a little larger.** It was 10px,
  which on a 1080p display sat below what the one piece of always-visible
  environment chrome should need to be read at a glance from the corner of the
  eye. Now 11px with tighter letter-spacing, so roughly the same number of
  characters still fits in the 72px rail before truncating, and the active
  environment's label is medium weight — "which environment am I in" now reads
  from the type as well as from the background tint.

### Fixed

- **The README pointed Windows users at a `.msi` that no longer exists.**
  Windows bundling moved from WiX/MSI to NSIS in 1.7.0 (see gotcha #21 in
  `CLAUDE.md` for why: WiX v3 was archived in February 2025 and its
  `light.exe` stopped running on GitHub's Windows runners at all), so releases
  have been shipping a `-setup.exe` for several versions while three places in
  the README — the download instruction, the SmartScreen note's SHA-256
  advice, and the tech-stack bundling line — still named the MSI. Anyone
  following the README looked for a file that isn't attached to the release.

- **Folding a connection group in one surface silently folded it everywhere else it was on screen.** `useConnectionGroupCollapse` (`src/lib/connection/useConnectionGroups.ts`) is shared by the File menu, the connections manager dialog, the status-bar switcher and the environment's Schema tree; in the default "remember" mode it read `prefs.ui.collapsedConnectionGroups` as a live Zustand selector, so every mounted instance re-rendered off the same value on every toggle. Opening the connections manager while an environment's tree already had a group open showed it open too (as expected — same remembered layout), but collapsing that group _inside the dialog_ also collapsed it live in the tree behind it, because both surfaces were really one shared instance of the fold state rather than independent views that merely started from the same saved arrangement. The hook now seeds a per-instance session override from the persisted set once, at mount, and every toggle — in all three expand modes, not just the forced "expanded"/"collapsed" ones — only touches that instance's local state; "remember" toggles still write through to disk so the _next_ surface to mount (including a future app launch) picks up the latest arrangement, but an already-open surface elsewhere is no longer reshaped out from under the user. No preference or on-disk schema changed.

- **The "Restart now" button gave no feedback after being clicked, inviting repeat clicks.** `installAndRelaunch` (`src/stores/update.ts`) went straight from `readyToRestart` to a transient `ready` right before `installUpdate()`/`relaunchApp()` — but everything in between (an async MCP-sidecar check, and its confirmation dialog if a client currently holds the sidecar) ran while the store still reported `readyToRestart`, so both `UpdateBanner` and the Settings → About updates card kept rendering the idle "Restart now" / "Install and relaunch" label with the button fully clickable. A new `installing` status is now set synchronously the instant the click handler runs, before any `await`; both components disable their install button and the banner's dismiss controls and swap in a spinner + "Restarting…" label for the whole gap. `installAndRelaunch` also short-circuits if it's called again while already `installing`/`ready`, so a stray double-invocation can't queue a second install even if a click slips through.

## [1.14.0] — 2026-08-13

### Added

- **The command palette (Ctrl/Cmd+K) is now a real launcher.** It used to index
  three things — the saved connections, the selected connection's tables, and a
  fixed handful of actions (new query, preferences, theme, language) — filtered
  with a plain substring `includes()`. It now indexes thirteen groups and ranks
  them:
  - **Every individual preference**, VS Code style: typing `#wrap` (or just
    `wrap`) finds "Soft-wrap long lines", shows its current value, and Enter
    opens Preferences on that section and scrolls to _that row_, flashing it.
    Boolean settings can also be flipped without leaving the palette with
    Alt+Enter, which keeps it open so the value badge updates under the cursor.
    Every rebindable shortcut is indexed the same way, with its current combo.
  - **The documentation** (each in-app doc, plus What's new, Report/suggest,
    Check for updates, About, the MCP setup page).
  - **Navigation**: open tabs (Enter jumps, Alt+Enter closes), saved
    connections (Alt+Enter disconnects a live one), environments, the databases
    of a multi-database server, tables and views across _every_ connected
    connection rather than only the selected one, saved queries and the last 20
    entries of the query history.
  - **Actions** that previously existed only in a menu: new/manage connection,
    import/export profiles, disconnect all, refresh schema, refresh the active
    table's data, close/pin the active tab, close all tabs, new window, reset
    layout, float the active panel, and a toggle per dock panel.

  Search itself changed shape: entries are scored rather than filtered
  (`src/lib/commandPalette/fuzzy.ts` — prefix beats word-start beats substring
  beats subsequence, with run-density and word-boundary bonuses and a
  shorter-is-better tiebreak), the characters that matched are emphasised in
  each row, groups are ordered by their best hit so section headers stay
  coherent, and the commands you actually use float to the top under a
  "Recently used" heading (persisted in `localStorage`).

  Mode prefixes narrow the search the way they do in VS Code — `>` actions,
  `@` tables, `#` settings, `?` help, `:` go to — shown as clickable chips
  while the field is empty and cyclable with Tab, so a connection with
  thousands of tables can't bury the actions.

- **`Ctrl/Cmd+Shift+P` opens the palette in actions-only mode** (VS Code
  parity). Rebindable like the rest, under Settings → Shortcuts.

- **The palette can index a multi-database server's tables on demand.** A
  server-wide connection starts with only its _database_ list loaded — each
  database's tables arrive under its own `<parent>::db::<name>` slice, and only
  once something opens that view — so a freshly connected server had databases
  to offer and no tables to search. `@` mode now also lists an "Index all
  databases of X" entry while any of them is still cold; running it opens those
  views three at a time and keeps the palette open so the tables land under the
  cursor. It is a deliberate action rather than an automatic fan-out on every
  keystroke because each view is another connection pool — same reasoning, and
  the same concurrency cap and connection-limit circuit breaker, as the schema
  explorer's cross-database search (`src/lib/commandPalette/warmSchema.ts`).
  The per-connection "databases to show" subset is honoured, so a database
  hidden in the tree stays hidden in the palette.

- **Import/export a theme from Settings → Appearance.** An export icon next
  to the theme editor's mode picker writes the active theme (built-in or
  custom) to a JSON file via the native save dialog; an import icon in the
  theme list's header reads one back as a brand-new custom theme (always a
  fresh id, never colliding with an existing one) and switches to it
  immediately, the same as duplicating a theme already does. The file format
  is a small versioned envelope (`src/lib/themeTransfer.ts`) — themes live
  entirely in the frontend's `localStorage`-backed store, so the only
  backend piece needed is a narrow `write_text_file` command mirroring the
  existing `read_text_file` used by SQL import.

- **A "Summer" built-in theme** — a light, warm palette (sun-bleached sand
  background, a single ocean-teal brand/ring accent, coral primary and
  destructive tones) joining the existing built-in set in
  `src/lib/themes.ts`.

- **Per-environment theme override.** The environment create/rename dialog
  (`EnvironmentEditorDialog`) gets a theme picker alongside the existing
  colour field, listing every built-in and custom theme plus a "Default"
  option. Assigning a theme to an environment applies it automatically
  whenever that environment is entered — at launch or on `switchTo` — and
  clearing it (the default option, always available) falls back to whatever
  theme is set in Settings → Appearance. The override is layered on top of
  the existing theme store (`useThemeStore.setEnvironmentOverride`) rather
  than overwriting the persisted default, so switching back to an
  environment with no override never loses the user's regular theme choice.
  Persisted on the backend as `Environment.themeId` (`tab_state.json` v4;
  `None` by default, so existing environments are unaffected).

- **Double-click a column's edge in the data grid to fit it to its content**
  (HeidiSQL's gesture). A value too long for the default width — a serialised
  widget config, a description paragraph — no longer has to be opened in the
  cell editor just to be read: the column grows to the widest value currently
  on screen and stays there (persisted per table, like a manual resize).
  Holding `Ctrl`/`Cmd` while double-clicking fits every column at once, and the
  handle's tooltip spells both gestures out. The grid's toolbar also gets a
  button for the fit-everything version, so it isn't only reachable through a
  gesture you have to know about — table tabs and query results alike.
  The fit is measured against the text as _rendered_ (BIT display mode, the
  NULL placeholder, the "truncate long text at" cap all apply) and capped at
  900 px, so one wide column can't push the rest of the row off-screen;
  dragging by hand still goes as wide as you like.

- **The grid's toolbar is responsive.** On a narrow pane it used to split into
  two rows, with the filter cluster on one and the action cluster on the other.
  Now the actions leave the bar instead: the toolbar measures its own width
  (it lives in a dock panel, so a media query would be measuring the wrong
  thing) and collapses in two steps — first the labelled data actions (insert,
  import, export, bulk update) move into a single `⋯` overflow menu, then, on a
  genuinely narrow pane, so does everything else, leaving the search box and
  the `⋯`. Active filter chips fold into one "2 filters" chip whose dropdown
  still removes them one at a time, and the row count / query time move into
  the menu rather than disappearing — except on a grid with nothing else to
  collapse (an ad-hoc query result), where they stay in the bar because there
  would be no menu to read them in.

- **The outer window shell is now activity-bar-driven instead of five equal
  dockview panels.** Schema, Saved, Console, the cell editor, and the
  workspace used to live as interchangeable dockview groups the user could
  drag, tab together, or float — which visually implied you could spin up
  more "workspaces," never the intent. Console now docks to the bottom with
  its own collapsible header; Saved collapses/expands from a button in a new
  right-hand activity bar; the cell editor is a plain flex split _inside_ the
  workspace island rather than a sibling dockview group (so opening/closing
  it can no longer trigger dockview's proportional-reflow-of-siblings side
  effect); and the workspace itself is a fixed, un-draggable "island" card
  with its own header, wrapping the open table/query tabs area unchanged.
  Every panel now animates open/closed (200ms ease, suspended during an
  active sash drag so resizing still tracks the pointer 1:1) instead of
  mounting/unmounting instantly. New VS Code-style toggle buttons in the
  header's top-right corner (`PanelLeft`/`PanelBottom`/`PanelRight` icons)
  show/hide Schema, Console, and Saved independently of the activity bars.
  Layout state moved to a small store (`stores/session/panelLayout.ts`,
  persisted separately from the old dockview blob) since dockview's panel
  API has no `setVisible` for a normal panel — there is no way to collapse
  one to 0px without removing it, which reflows its siblings. The nested
  dockview inside the workspace island (open table/query tabs, their own
  split/float geometry, drag-and-drop) is completely unaffected.

- **The left activity bar is now a Discord/Teams-style environment rail**
  instead of a single generic "Schema" button. Every environment gets its
  own avatar (initials over its accent colour, in a rounded square — see the
  next entry) with its name underneath; a trailing "+" opens the same
  create dialog the status-bar switcher already had. Clicking a
  non-active environment switches to it _and_ opens the Schema panel in one
  gesture; clicking the already-active one just collapses/expands Schema —
  there is no separate dedicated toggle button anymore since that would be
  redundant with it. Right-clicking an avatar opens the same rename/delete
  context menu the status-bar switcher's dropdown rows offer, so environment
  management doesn't require a trip down to the status bar. The status-bar
  switcher (`EnvironmentSwitcher`) is unchanged and still there — this is an
  additional, not a replacement, way to switch.

- **Environments render as a Teams-style initials avatar** — up to two
  letters derived from the name, over the environment's accent colour (a
  neutral fallback when none is set), foreground colour picked for contrast
  automatically. Replaces the old lucide icon picker in the environment
  create/rename dialog, which is gone; the dialog now shows a live avatar
  preview next to the name field instead. Used everywhere an environment is
  shown: the new rail, the empty-workspace environment picker cards, and the
  create/rename dialog's preview. The status-bar switcher deliberately keeps
  a plain colour dot instead — too small at that scale for initials to stay
  legible. `Environment.icon` is unread but kept on the wire (both in the
  store and in the backend's `tab_state.json` struct — no migration was
  needed) as the future home for a custom uploaded image, which is designed
  in but not yet built: the avatar component is structured so an `env.icon`-
  backed `<img>` branch can be added later, taking priority over the
  initials, without touching any call site.

### Changed

- **A workspace tab now shows the table's name instead of running out of room
  before it.** With tabs open across several connections, each one printed
  `connection · database · database.table` — the database twice — and the part
  that actually tells two tabs apart, the table, was the part that fell off the
  end. The database appears once now, and the label truncates by priority: the
  connection context (repeated on every tab of that connection, and already
  signalled by the driver badge) gives up its width first, the name keeps
  hers, separated by a hairline rather than one more `·` in a name full of
  them. Hovering a tab shows its full identity — qualified `schema.table` and
  the connection — after a shorter delay than a chrome button's, since on a
  truncated tab the tooltip is the only way to read the whole name.

- **Clipped tabs fade out instead of being cut**, the way an IDE's tab strip
  does — both a name too long for its tab and the tab straddling the edge of
  a strip with more tabs than fit, which used to be chopped mid-letter against
  a hard vertical wall. Each fade appears only where something really is cut
  off: a name that fits keeps its full tail, and a strip with room to spare
  keeps clean edges. The faded edge doubles as the cue that there are more
  tabs that way.

- **The tab strip's "∨" button looks like a button**: its own surface and
  border, on the strip's recessed backdrop. It no longer prints the number of
  hidden tabs beside the chevron — the chevron already means "there is more",
  the list itself shows how much, and the count only competed with the tab
  names next to it.

- **The tab overflow menu ("∨ N") is the tab strip stood on its side.** It
  re-uses each hidden tab's own tab component, so every row arrived with the
  strip's _horizontal_ geometry: a one-sided 7px margin, the strip's
  truncation width inside a popover with room to spare, and two scrollbars,
  one of them horizontal. The chips stay — same trench backdrop, same fill and
  elevation, so the popover reads as part of the same surface — but each is
  full-width now, with the name on one line and its connection under it, the
  active one marked by a left rail rather than a top cap, and the popover
  scrolls in one direction only.

- **Removed the "⊞ N" button from the tab strip.** It opened the modal tab
  switcher, two pixels from the "∨ N" overflow list that answers the same
  question in place. The dialog itself stays on `Ctrl`/`Cmd`+`P` (rebindable),
  which is still the only way to search every open tab by name.

### Fixed

- **Jumping to a tab or table of a per-database view left the workspace
  pointing somewhere else.** A tab of a multi-database server carries the
  synthetic `<parent>::db::<database>` connection id, but
  `useConnections.active` only ever holds top-level profile ids (`markConnected`
  runs in `connect()`; a database view is opened by `open_database_view`), and
  `App.tsx` clears `selectedConnectionId` whenever it isn't in that set. So
  selecting a child id was undone a render later and replaced by whichever pool
  came first — nondeterministically. Both the tab switcher (pre-existing) and the
  command palette's new table/tab entries now resolve the owning profile through
  `parentConnectionId`; the tab itself keeps the child id, which is what scopes
  its queries.

- A single click on a column's resize handle no longer rewrites that column's
  width in `prefs.json` with the value it already had.

- Closing a tab from the "∨ N" overflow list left a dead row behind, showing
  the tab's internal id where its name had been. dockview builds that popover
  once, at open time, and never rebuilds it, so it now closes along with the
  tab that was closed from it.

## [1.13.0] — 2026-08-12

### Added

- **Microsoft SQL Server driver** — the fifth engine, requested by users
  running HuginnDB against SQL Server. Connect (with SSH tunnel support),
  browse databases/schemas/tables/views/indexes with row counts and sizes,
  run T-SQL in the editor, page/sort/filter the grid, edit cells, insert and
  delete rows, bulk update, and the users/permissions panel. Named instances
  (`HOST\SQLEXPRESS`) are resolved through the SQL Browser, and a "trust
  server certificate" toggle — on by default — makes the self-signed
  certificates most on-premise instances present usable. On Windows builds the
  connection dialog also offers Windows (NTLM) authentication with an explicit
  `DOMAIN\user`; the mode is hidden elsewhere because the underlying driver
  only compiles it for Windows.
- Minimum supported server is **SQL Server 2012**: paging uses
  `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, which does not exist before that.
- The new engine is wired into the connection accounting below rather than
  sizing itself: `tiberius` has no pool, so HuginnDB's own session pool takes
  the same per-server grant every other driver takes, closes explicitly on
  disconnect instead of waiting for a drop, and releases sessions left idle
  for five minutes.
- **Settings → Connections** — a new preferences section for the connection
  pool: the ceiling for a connection and for a per-database view, how many
  database views one connection may keep open, how long an unused one survives,
  and the keepalive interval. It also shows, live, how many pools HuginnDB is
  currently holding, with a button to release the per-database ones. That
  visibility is half the point: `too many connections` is only actionable if
  you can see your own contribution to it.
- **Per-server connection budgets.** The unit of accounting is now the server
  endpoint, not the saved connection. `Max connections per server` is the whole
  allowance HuginnDB will spend against one host, shared by every connection and
  every database view that reaches it — so three connections pointing at the
  same Postgres box no longer get three independent allowances, which is exactly
  how the footprint managed to be unbounded. Two connections behind _different_
  SSH tunnels that both name `localhost:5432` are correctly treated as different
  servers; two connecting as different users are correctly treated as the same
  one, since the server's limit is global.
  When a server's allowance is spent, opening a database view **closes the view
  you used least recently on that same server** rather than failing — so
  browsing a twelve-database server under a ten-connection budget still works.
  If there is genuinely nothing to reclaim, the error names the budget and where
  to raise it instead of surfacing a driver string.
- **Per-connection limit** — connections now have a **Max connections for this
  server** field. Connection capacity is a fact about a _server_, so it lives on
  the connection: it travels with profile export/import, syncs through shared
  origins, and the `huginndb-mcp` sidecar honours it automatically because it
  reads the same `profiles.json`. Blank means "use the global preference".
- **`huginndb-mcp --max-connections <n>`** — pool ceiling per exposed
  connection for the headless connector, defaulting to `2`. See the new
  "Connection footprint" section in `docs/MCP.md`.
- **Pool sharing with the MCP connector** (Settings → Connections → _Share
  pools with the MCP connector_, off by default). With it on, a running
  `huginndb-mcp` sidecar stops opening its own pools and asks the desktop app to
  run its queries instead. The machine then has **one budget per server**
  however many MCP clients are configured — until now each spawned its own
  sidecar with its own pools, invisible to the app and to each other. Two
  further consequences worth the switch on their own: the connector's activity
  appears in the app's **Console live**, every browse and write as it happens
  rather than only in `mcp-audit.log` afterwards; and the app re-checks each
  connection's write policy itself, independently of the sidecar's own check.
  The transport is a loopback-only listener with a per-run token kept in a
  `0600` file next to `profiles.json`. When the app isn't running, or the
  setting is off, the connector behaves exactly as before.
- `docs/CONNECTION_POOLING_ANALYSIS.md` — the audit these changes come from:
  how the engine allocated connections, worst-case arithmetic, ranked findings,
  and the endpoint-centric architecture the remaining work is heading towards.
- **Editable list view.** The row-per-card list view is no longer read-only: it
  is now a document editor in the shape MongoDB Compass made familiar. Nested
  objects and arrays arrive **folded** and open on demand, each field is one
  numbered line with its type in the right gutter, and **double-clicking a value
  edits it in place** (Enter or blur commits, Esc cancels, ∅ writes NULL). The
  expand button escalates the field to the same Monaco editor the table view
  uses — modal or docked, following the existing `cellEditorMode` preference —
  which is how a whole sub-document is edited as JSON.
  On MongoDB the type gutter is a **picker**: choosing a type rewrites the field
  as that BSON type (the full Compass vocabulary — `Binary`, `UUID`, `Code`,
  `Timestamp`, `MinKey`/`MaxKey`, `BSONRegExp`, `BSONSymbol`, `Undefined` and
  the ones already supported), fields can be **added** (a `$set` on a new path,
  including inside a nested object or appended to an array) and **removed** (a
  new `unset_field` command issuing `$unset`, behind the destructive-action
  confirmation). A document's `_id` stays read-only: `$set` on it fails
  server-side, so offering the edit would only ever produce an error.
  Editing a **nested** field addresses it by its update path
  (`customData.format`, `tags.2`), so a value inside a sub-document is written
  without rewriting the document around it.
- **MongoDB results now carry their real BSON types.** `QueryResult` gained a
  `row_types` field: one type tree per cell, mirroring the value's structure
  (`bson_type_tree`). The display JSON is deliberately lossy — `Int32`, `Int64`
  and `Double` all arrive as JSON numbers, `ObjectId`, `Date` and `Decimal128`
  all as strings — so without it the list view would have had to guess a type
  from the value and would have rewritten a `Long` as an `Int` the first time
  anyone fixed a typo in an unrelated field. The SQL drivers leave it unset;
  their column types were never ambiguous.

### Changed

- **The list view works on every driver.** It shipped in 1.11.0 as a
  MongoDB-only rendering, but the problem it solves — a wide or nested row that
  scrolls sideways and flattens its nested values into one unreadable line — is
  not MongoDB's alone: a 40-column table, or a row with a big `jsonb` column,
  has exactly the same shape. The toolbar toggle is now offered for
  PostgreSQL/MySQL/SQLite too, values are editable there through the same
  `update_cell` path as the table view, and nested values inside a JSON column
  fold like a sub-document. The three affordances that only make sense for a
  document database — add field, delete field, change type — stay hidden for
  SQL, where a row's column set belongs to the table, not to the row.
- **The view-mode preference moved to Settings → Appearance**, into a new
  **Data view** group, and lost its MongoDB-specific wording. It sits next to
  the theme editor because it answers the same question ("what does this look
  like") rather than "how does the grid behave", and it now carries three
  list-view options: whether nested values start expanded, whether the type
  gutter is shown, and whether fields are numbered. The stored key
  (`grid.documentViewMode`) is unchanged, so an existing choice survives.
- **`connections.maxConnections` changed meaning** from "ceiling for a single
  pool" to "total for one server". Nothing was released with the old meaning, so
  no migration is needed; the default moved from 5 to 10 accordingly, since it
  now covers a connection plus its database views rather than one pool. A
  top-level connection asks for at most 5 of that allowance and deliberately
  leaves room for a database view, so pinning a tight budget on a connection
  can't make its own databases unopenable.

### Fixed

- **A narrow grid column no longer hides the field name in favour of its type.**
  The header lays the name and the data type on one line, and both were plain
  flex items — but only the name was allowed to shrink, because `truncate` is
  what lets a flex item go below its content width. So the first thing a column
  too narrow for its content threw away was the one part that identifies it: a
  `BOOLEAN` column rendered as a bare "BOOL", with nothing left of the name. The
  priority is now inverted — the type is clipped away first, down to nothing,
  and the name only starts eliding once the type is gone.
- **The column-header tooltip describes the field instead of advertising
  sort actions.** It now shows the full name (the thing a narrow column
  clips), the full type, primary/foreign key with the referenced
  `table.column`, nullability when the catalog knows it, and the current sort
  state — and it is translated, which it never was. The old text offered
  "Ctrl/Cmd+click to add a column", which read as an offer to _create_ a
  column: wrong, and alarming in a window that also runs DDL. Sorting stays
  discoverable through the arrow glyph on every header.

- **"Databases to show" no longer leaks between environments.** The subset was
  stored on the connection, and a connection is global — so restricting a shared
  test server to one client's database while inside a "Producción" environment
  also hid every other database from the environment that server actually
  belongs to. The picker now asks where the choice applies: **this environment**
  (the default) keeps it local, so the same connection can show every replica in
  one environment and a single database in another; **all environments** saves it
  on the connection as before, which is also the value that travels through
  profile export/import and shared origins. An environment without its own choice
  follows the connection's, so nothing changes until you pick otherwise, and
  existing subsets keep working untouched. A connection published by a shared
  origin is read-only, so only the local scope is offered for it — previously its
  databases could not be filtered at all without the next sync undoing it.
  Connections are deliberately **not** cloned per environment: that would
  duplicate credentials and keychain entries and open a second pool against one
  server. Only the view of them is scoped.
- **The connection tree's filters now survive with auto-reconnect off.** Which
  connections are shown, which rows are folded, and the new per-environment
  database subsets are restored when an environment is entered regardless of the
  _Reconnect on launch_ preference. They describe how an environment looks, not
  what it reopens; behind that gate, entering an environment with reconnect off
  left the previous one's filters on screen.
- **`too many connections` on shared servers.** HuginnDB's connection footprint
  was unbounded, invisible, and multiplied across processes it did not
  coordinate with — which on a database also serving a JetBrains data source, an
  application backend's pool and one or more MCP sidecars was frequently the
  straw that broke the server. Several things were wrong at once:
  - Browsing a multi-database server opened a **whole extra pool per database**,
    each with its own independent ceiling of five, and nothing ever closed them
    short of disconnecting the parent connection. A server with twelve databases
    was a ceiling of ~65 backends from a single window, held until the app
    closed. Per-database pools are now capped at **2** connections, limited to
    **8 open views** per connection (longest-unused closed first), and closed
    automatically after **5 minutes** unused. They reopen transparently on next
    use, so nothing is lost but the round trip.
  - The schema explorer's cross-database search fanned out `openDatabaseView`
    across **every** visible database at once — on a nineteen-database server, a
    single keystroke was nineteen simultaneous connection attempts. It now runs
    at most three at a time and drains as a queue.
  - The MongoDB client set no pool bound at all, inheriting the driver's default
    of **100 per host** — a 20x divergence from the SQL drivers, by omission. It
    now takes the same budget as everything else.
  - Pools were torn down by `Drop` rather than an awaited close, so a
    reconnect or an environment switch could transiently hold both the outgoing
    and incoming sessions. Disconnect (and every other teardown path) now closes
    gracefully, with a timeout so a dead server can't stall it.
  - `min_connections` / `idle_timeout` / `max_lifetime` / `acquire_timeout` were
    left to `sqlx`'s implicit defaults. They are now set explicitly, and the idle
    timeout shortened to 5 minutes so an untouched pool gives its sockets back.
  - "Test connection" opened a five-connection pool to run one `SELECT 1`. It
    now opens one, and closes it.
- **The MCP connector never released a pool** for the lifetime of its process —
  which is however long the MCP client keeps it, typically days. It now closes
  pools unused for five minutes and defaults to a ceiling of 2 rather than
  inheriting the desktop app's 5.
- **`too many connections` is now recognised as such** rather than surfacing as
  an opaque driver string: Postgres `53300`/`53400`, MySQL `1040`/`1203`, the
  MongoDB pool timeout, and our own pool's acquire timeout. The message reports
  how many pools HuginnDB itself is holding and notes that other clients on the
  machine share the server's limit; the search fan-out stops instead of
  re-firing against a server that is already refusing it, and offers to release
  idle pools and retry.
- **Editing a connection silently reset fields the dialog doesn't show.**
  `save_profile` replaces the whole record, and the dialog rebuilt it from form
  state only — so saving a connection wiped its MCP write policy back to
  read-only and dropped its visible-databases subset. The dialog now preserves
  the stored profile's fields it doesn't edit.
- The MCP connector's write-policy classifier treated two T-SQL statements as
  reads: `SELECT … INTO <table>` (which creates a table) and `EXEC`/`EXECUTE`
  (which can rename objects or run dynamic DDL). Both are now classified as
  DDL, so a `read-only` or `data`-tier connection refuses them.
- The MCP `list_connections` tool reported the driver from a `Debug`
  representation, so a MongoDB connection came back as `"mongo"` instead of the
  `"mongodb"` every other surface uses.

### Known limitations (SQL Server)

- The **structure editor is read-only**: columns, keys, indexes and foreign
  keys are shown, but applying changes needs a T-SQL DDL builder that isn't
  written yet. Renaming a table (`sp_rename`) and the **view editor** are
  unavailable for the same reason.
- **`.sql` export/import** is not available yet; it needs a T-SQL literal
  encoder and `IDENTITY_INSERT` handling.
- Integrated/SSPI authentication (log in as the current Windows user without
  typing credentials) and Entra ID tokens are not offered.
- A named instance cannot be combined with an SSH tunnel: the SQL Browser is a
  separate UDP service the tunnel doesn't forward. Tunnel the instance's own
  TCP port and leave the instance field empty.

## [1.12.1] — 2026-08-05

### Added

- **Bulk update** — update every row/document matching a filter in one
  round trip, for all four drivers. A new "Bulk update…" toolbar button
  opens a dialog that reuses the DataGrid's own advanced-filter condition
  builder for the match side, plus a column/field → value editor for the
  set side; a debounced preview shows the exact `UPDATE ... SET ... WHERE
...` (or `db.<collection>.updateMany(...)` for MongoDB) and how many
  rows currently match before anything runs. An empty filter is rejected
  unless explicitly acknowledged, so a blank condition can't silently turn
  into a full-table update.
- **Export/import controls moved into the DataGrid toolbar.** MongoDB's
  per-collection JSON export/import (previously only reachable from the
  schema tree's right-click menu) and new SQL equivalents now live next to
  the grid's "Insert" button: an "Export data" dropdown offers "export the
  full table/collection" or "export query results" (scoped to the grid's
  current advanced filter, unpaginated); MongoDB additionally gets an
  "Import JSON…" entry in the same cluster. A new bottom toolbar row holds
  pagination and row-zoom controls, separated from the header's data
  actions.
- **"Export database…" is now a proper dialog**, reachable from both a
  connection's own context menu (pick one or more databases, and — per
  database — which tables) and, in multi-DB mode, a specific database's own
  menu (locked to that one database). Everything checked is written to a
  single combined `.sql` file, with a "Data" mode choosing plain `INSERT`s
  or a delete-then-insert form that survives re-running the dump against a
  target that already has data. Replaces the old one-click, always-whole-
  database export.
- **"Import .sql…" is now a confirmation dialog** instead of a bare
  browser-native confirm: it shows the statement count up front and, for a
  multi-DB connection, lets you pick which database to run the file
  against (or run it as-is, for a file that already addresses its own
  database via `USE`/qualified names).
- **Structure editor: categorised type picker.** The column type combo is
  now grouped by category (Integers/Real/Text/Date & time/Binary/Other, one
  catalog per driver) with a separate length/precision field, plus MySQL
  unsigned/zerofill checkboxes — first pass of a broader HeidiSQL-style
  rework of table creation/editing.
- **Renaming a table from the structure editor** now works: the Name field
  is editable in edit mode again, and applying a rename updates the open
  tab's title (and any other open tab for that table) instead of leaving it
  showing the old name. The schema tree's existing quick-rename dialog got
  the same fix.

### Changed

- The schema tree's per-table (MongoDB) and per-schema (SQL) "Export…"/
  "Import…" context-menu entries were removed now that the DataGrid toolbar
  and the new connection-/database-level dialogs cover the same ground —
  the per-schema entries in particular were mislabelled (they exported the
  _whole database_, not the clicked schema). Connection-level and
  per-database export/import remain in the tree. The "(Beta)" suffix on
  "Export database…"/"Import .sql…" is gone.
- The structure editor's columns table was redesigned with the app's own
  bordered/zebra-striped grid look instead of a bare `<table>` of plain
  inputs, with a key icon marking the primary key.
- Dragging a table/query tab to split the workspace now shows a distinct
  highlight for "split in this direction" versus "add as a tab here"
  instead of one flat overlay, and sibling panels ease into their new size
  on drop instead of snapping.

### Fixed

- The structure editor's ALTER builder (Postgres/MySQL/SQLite) never emitted
  a table-level `RENAME TO`, even though it already handled column renames;
  the SQLite destructive rebuild path had the mirror bug in its `INSERT`/
  `DROP` source. Both fixed.
- The `rustfmt` CI job was failing on every run (not flaky) because of an
  unformatted line left over from an earlier commit.

## [1.12.0] — 2026-08-03

### Added

- **Environments** — a new level above connections: a named set of
  connections plus its own tabs, pane layout and reconnect behaviour,
  switchable from a topbar selector (#109).
- **Shared origins** — sync an environment's connections (and passwords)
  from a shared config file, so joining a team means entering a passphrase
  once instead of configuring every connection by hand (#108).
- **Connections now live in the schema tree**, as its top two levels above
  folders; a connection's actions moved to its right-click menu (#107).
- **A searchable, tabbed workspace picker** (connections and environments)
  replaces the old empty-workspace placeholder (#110).
- **Table tabs remember their filters, sort and search** across a session
  restore (#112).
- **Filter by the selected rows** — right-click a column with rows selected
  to add a server-side `IN`/`NOT IN` filter (#114).
- **Redesigned query run feedback**: a live run timer, a 75/25 editor/
  results split by default, and a searchable history sidebar with
  per-entry "run again."
- **Neon**, a new near-black dark theme with a signature neon accent
  palette.
- Open table/query tabs now use the app's "island view" look, with a
  permanent per-tab driver-logo badge.
- Data-grid columns now show a visible divider, size themselves by type
  (booleans/numbers/dates/UUIDs get a sensible width from the start), and
  resize with a real live preview instead of a static guideline.

### Changed

- "Go to referenced row" moved from Ctrl/Cmd+click to Alt+click, freeing
  that chord for row multi-selection (#113).
- The global status bar no longer duplicates the query editor's own row
  count, timer or read-only badge.

### Fixed

- Several environment-switch bugs that could lose open tabs, focus or
  split layout, or silently collapse a split back into one tabbed group.
- A `SELECT` preceded by a comment ran correctly but showed no rows.
- Ctrl/Cmd+click now reliably toggles row selection, including on tables
  without a primary key (#113).
- Long dropdown/context menus now scroll instead of clipping (#111).
- Fixed the MySQL/Postgres table-browsing regression from 1.11.0's
  row-count split: the count no longer competes with the data fetch for a
  pooled connection.
- Driver logos and the theme swatch are now theme-aware instead of sitting
  on a fixed light tile.

### Performance

- Clicking a row/cell in the data grid, and opening a new tab alongside
  several already-open ones, no longer re-renders every other row/tab —
  both previously scaled with the total row/tab count.

## [1.11.0] — 2026-07-24

### Added

- **MongoDB list view.** Collection tabs for a `mongodb` connection now offer
  a table/list toggle in the toolbar (only shown for that driver — every
  other driver keeps rendering as a table). List mode renders each document
  as a card with one `field: value` line per top-level column instead of one
  column per field, which was the actual pain point: a document with many
  fields, or with a nested object/array value, forced constant horizontal
  scrolling in table mode and flattened the nested value into a single-line
  JSON blob that was hard to read. List mode pretty-prints nested
  objects/arrays with indentation instead. It's deliberately read-only for
  this first pass — no inline cell editing, no insert/duplicate draft row —
  since those need the table's editable-row UI; per-row "Copy as JSON" and
  "Delete" still work directly from the card, since neither needs it. The
  chosen mode is a single global preference (`grid.documentViewMode` in
  `prefs.json`, also exposed in Settings → Grid), not per-collection — same
  tier as `rowHeight` or `bitDisplay` — so switching once applies to every
  MongoDB collection you open afterwards.

- **Reconnect on launch.** A new General preference (default on) makes the
  main window automatically reconnect, at startup, to the connections that
  were live when it was last closed — using the credentials already in the
  OS keychain. Previously the app opened disconnected and you had to
  reconnect to each host by hand (and, because of the layout bug below, in
  the _right order_) to get your workspace back. Connections whose password
  isn't stored, or whose host is unreachable, are skipped without blocking
  startup; the toggle lets you opt out entirely. The launch state — which
  connections were live, which one was focused, and which tab was active — is
  persisted on graceful close and opportunistically on each
  connect/disconnect, so the workspace comes back the way you left it (same
  connection in focus, same tab, same pane layout) regardless of the order the
  pools happen to reopen, and even an abrupt exit leaves something to restore.

- **Canary build channel.** A new opt-in pre-release channel lets a change be
  dogfooded against real production connection profiles _before_ it ships in a
  stable release — no full release required. A canary build (compiled with the
  new `canary` Cargo feature, paired with `src-tauri/tauri.canary.conf.json`)
  installs side-by-side with the stable app: it has its own bundle identifier
  (`io.huginndb.canary`), product name ("HuginnDB Canary"), and a separate
  auto-updater feed, and it isolates all of its on-disk state into a dedicated
  `HuginnDB-Canary` config directory. That isolation means a canary can safely
  exercise destructive, one-way on-disk migrations without ever touching the
  stable install's `profiles.json` / `tab_state.json` / `prefs.json`. The OS
  keychain service is deliberately _shared_, so the canary reuses the passwords
  the stable build already stored rather than forcing them to be re-entered.
  Builds are produced by a manual `canary` GitHub Actions workflow from any
  branch or commit and published to a single rolling `canary` release; see
  `docs/CANARY.md`.

- **Sandbox indicator for the canary build.** Because the canary shares the UI
  bundle (and the OS keychain) with the stable app, once you were _inside_ the
  window the two were indistinguishable — easy to mistake the sandbox for your
  real install. The canary build now makes its identity unmistakable: a
  persistent amber "SANDBOX · HuginnDB Canary" ribbon pinned above the header
  (with the isolated state dir called out), a "CANARY" badge next to the
  header brand, a flavor-aware OS window title ("HuginnDB Canary" in the
  taskbar / Alt-Tab, which the frontend previously overwrote back to
  "HuginnDB"), and an About panel that shows the canary product name and its
  real `HuginnDB-Canary` state paths. The stable build is visually unchanged.
  A new `get_app_flavor` command exposes the compile-time `canary` feature to
  the frontend, since the two builds ship an identical JS bundle.

### Changed

- **The row-count no longer blocks the first rows from appearing, and a
  whole-table count is now an instant estimate.** Opening a table/collection
  used to compute the data page _and_ an exact `COUNT(*)` (`count_documents`
  on MongoDB) in a single round trip, returning nothing to the grid until
  both finished. On a multi-million-row table the count dominated, so the
  first paint waited seconds on a query whose 100 rows were already in hand —
  exactly the "Compass feels faster" report in issue #77. The count is now a
  separate request (`count_table_rows`) fired alongside the data fetch: rows
  render as soon as the `SELECT`/`find` returns, and the pagination range
  fills in the total when the count arrives (paging still works in the
  meantime). For a whole-table browse (no filters, no search) the total comes
  from the engine's O(1) statistics — `pg_class.reltuples` on Postgres,
  `information_schema.TABLE_ROWS` on MySQL, `estimatedDocumentCount` on
  MongoDB — and is shown as an approximate `~N` (hover for the tooltip). A
  never-analysed table (or SQLite, which has no cheap estimate) falls back to
  an exact count. Any active filter/search forces an exact count of the
  matching subset, but it still runs off the render's critical path. The
  headless `huginndb-mcp` `browse_table` tool is unchanged (it keeps the
  inline exact count).

- **Table-tab toolbar consolidated into a single bar (MongoDB Compass-style).**
  The top toolbar of a table/collection tab previously crowded four different
  concerns into its left edge — the reload button, the advanced-filter button,
  the MongoDB table/list view toggle, and a cramped fixed-width (`w-56`) search
  box — while a _second_ bottom status strip carried the row zoom and the
  pagination controls. Worse, the row total was shown twice: "37 rows of 37"
  top-right and "1–37 / 37" bottom-right. Everything now lives in one bar:
  - **Left (actions):** refresh · advanced filter · the search box — which is
    now the visual anchor, growing to fill the available width (capped, with a
    leading magnifier icon) instead of the old narrow fixed size — and the
    **Insert** button right beside it, since inserting is the other primary
    action on the row set.
  - **Right (display), pinned via `ml-auto`:** a single human-format
    pagination range (`1–100 of 19759`, replacing the old duplicated count and
    the slash form) · prev/next page buttons · the page-size selector · the
    row-zoom −/+ pair (lifted up from the deleted bottom strip) · the MongoDB
    view toggle (Mongo-only) · elapsed time.

  The bottom status strip is gone entirely, giving the grid more vertical room.
  Wired through a new `toolbarTrailing` slot on `DataGrid` (mirroring the
  existing `toolbarLeading`) plus a `showRowCount` prop: table tabs pass
  `false` because the pagination range supersedes the count, while query/view
  result tabs — which don't paginate — keep the built-in "N rows of M" as their
  only row-total indicator. No data behaviour changed; same actions, same
  keyboard shortcuts, purely a layout/affordance pass.

- **The workspace pane layout is now session-level, not per-connection.**
  The inner-dockview split/float geometry (how you've arranged the open
  table/query tabs) used to be stored redundantly under _every_ connection
  in `tab_state.json`, even though a single inner dockview hosts all
  connections' tabs at once. On restore, whichever connection you happened
  to connect to first won — so the layout only came back if you reconnected
  in a specific order. It's now stored once at the top level of
  `tab_state.json` and restored a single time at launch, independent of
  connection order. Existing per-connection layouts are migrated
  automatically on first load after upgrading (the most-recently-used one is
  promoted to the session layout), so nobody loses their arrangement.

- **"Float in new window" now opens a real, independent OS window.** A tab's
  "Sacar a ventana flotante" action used to call dockview's
  `addFloatingGroup`, which only detaches the panel _within_ the inner
  workspace's own bounds — the floating panel could be dragged around, but
  never past the edges of the workspace pane it came from, which defeated the
  point when you wanted, say, the cell editor free of the table view
  entirely. It now opens a bare, native `WebviewWindow` (`open_tab_window`,
  rendered by the new `DetachedTabWindow` root) that hosts just that one
  tab — no sidebar, no other tabs, no menus — and can be moved anywhere on
  the desktop like any other window. The tab is removed from the main
  window's workspace the moment it's popped out, so closing the detached
  window is simply the tab's close: there's no state to reconcile back.
  Applies to every tab kind (table, query, structure, view, security). Like
  "New window", these windows are ephemeral — they don't touch
  `tab_state.json` and aren't restored across restarts.

### Fixed

- **Double-clicking a cell's text no longer fails to enter inline-edit
  mode.** Since the "expand" icon landed (#78), a selected cell also grows a
  `ring-2 ring-inset ring-brand` border on the `<td>` itself, occupying the
  cell's edge/padding area alongside the value. On the Linux WebKitGTK
  webview, double-clicking directly over the value's text intermittently
  never fired the native `dblclick` event at all — a known WebKitGTK quirk
  where `user-select: none` (set table-wide, see `DataGrid.tsx`'s
  `select-none` note) suppresses `dblclick` specifically when there's
  selectable text under the pointer, while double-clicking the cell's empty
  padding (no text glyph under the cursor, which is what made it _look_
  like clicking "the border" was the trick) worked fine. The `<td>`'s
  `onClick` handler now also checks the native `click` event's own
  `detail` (the OS click count, unaffected by that quirk): a second click
  (`e.detail >= 2`) routes straight into `openCellEdit`, the same path
  `onDoubleClick` already used — so edit mode now opens reliably regardless
  of exactly where in the cell the double-click lands.

- **Typing into an inline cell edit no longer kicks the caret to the end
  of the value on every keystroke.** `DataGrid`'s `columns` memo listed
  `inlineEdit` (and `fkEditCell`/`selectedCell`) in its dependency array, so
  every keystroke — which updates `inlineEdit.value` — rebuilt the entire
  `columns` array, handing every column's `cell` renderer a brand-new arrow
  function reference. TanStack's `flexRender` treats `columnDef.cell` as a
  component _type_ (`typeof Comp === "function"` → `React.createElement(Comp,
props)`), so a new reference each render reads to React as a different
  element type for every cell in the grid — forcing a full unmount +
  remount of the whole table body, including whatever `<input>` was mid-edit.
  A freshly-mounted `autoFocus` input always plants its caret at the end,
  which is exactly what made moving the cursor mid-value and continuing to
  type impossible without retyping the whole thing. `fkEditCell`/
  `inlineEdit`/`selectedCell` are now mirrored into a `useRef` updated on
  every render instead of being memo dependencies; each column's `cell`
  function reads the live values off that ref, so its own identity — and the
  mounted DOM underneath it — stays stable across keystrokes.

- **Secondary windows ("New window") can now rearrange their panels.**
  Dragging a panel in a window opened via the Window menu always showed the
  "not-allowed" cursor: the window was built without the main window's
  `dragDropEnabled: false` setting, so Tauri's OS-level drag-drop handler
  stayed on and swallowed the HTML5 drag events dockview relies on. The
  secondary-window builder now disables that native handler, matching the
  main window exactly.

## [1.10.0] — 2026-07-23

### Added

- **Views can now be created, edited, renamed and dropped from the schema
  explorer (#86).** Until now a view showed up in the tree read-only —
  its context menu offered only Open / Copy name / Copy SELECT / Refresh,
  with every DDL action explicitly gated off (`!isView` in
  `SchemaExplorer.tsx`), and the backend had no query to even read a view's
  definition (`pg_get_viewdef` / `information_schema.views` /
  `sqlite_master.sql` were never called). The only way to touch a view was
  to hand-write `CREATE OR REPLACE VIEW` in the query editor — exactly the
  HeidiSQL-style raw-SQL experience the maintainer wanted to avoid,
  especially for views with several JOINs where it's hard to tell what
  columns/rows the definition actually produces just by reading the SQL.
  Rather than build a full visual join/query builder (roadmap item 9,
  explicitly low priority), the new "Edit view…" tab pairs a full-size
  Monaco SQL editor for the view body — with the same schema-aware
  autocomplete as the query editor — with a live, debounced "preview
  results" grid that runs the current draft (wrapped in a `LIMIT`-ed outer
  `SELECT`) so the actual columns and rows a JOIN produces are visible
  while typing, plus a read-only DDL pane (same pattern as the table
  structure editor) showing the exact statements Apply will run. New
  backend module `db/view_ddl.rs` builds driver-aware DDL from a diffed
  `ViewDefinition`: `CREATE OR REPLACE VIEW` on Postgres/MySQL (with an
  explicit `ALTER VIEW … RENAME TO` / `RENAME TABLE` first when the name
  changed), and always drop+recreate on SQLite (no `CREATE OR REPLACE
VIEW` / `ALTER VIEW` there) — informational only in the UI, since a view
  holds no data of its own to lose. Five new Tauri commands
  (`get_view_definition`, `preview_view_change`, `apply_view_change`,
  `rename_view`, `drop_view`) mirror the existing
  `get_table_structure`/`preview_structure_change`/`apply_structure_change`
  shape. MongoDB is excluded in this version, same as table-structure
  editing — its "views" are read-only aggregation-pipeline collections
  with a fundamentally different edit model (`collMod`/`createView`).
- **A `between` operator in the Advanced Filter, unifying range filtering across
  every driver (#81).** The advanced-filter builder already offered
  `contains`/`not_contains`/`starts_with`/`ends_with` consistently on Postgres,
  MySQL, SQLite and MongoDB (verified while investigating this issue — MySQL's
  `contains` was already working via the shared `CAST(col AS CHAR) LIKE`
  path), but no operator existed to filter an inclusive range in one
  condition; a user had to stack a `gt`/`gte` row and a `lt`/`lte` row instead.
  `FilterOp::Between` is now a single shared variant consumed by
  `build_filter_clause` (SQL: `col BETWEEN ? AND ?` / `BETWEEN $N AND $N+1`)
  and Mongo's `build_filter` (`{ $gte, $lte }`), backed by a new `value2`
  field on `ColumnFilter` (added on both the Rust struct and its TypeScript
  mirror — a value dropped silently by serde otherwise, see gotcha #14). The
  dialog offers it alongside `gt`/`gte`/`lt`/`lte` for numeric/date columns
  and renders a second "to" input when selected.

- **A single click now shows a direct "expand" icon on the selected cell,
  so its full value can be viewed without first double-clicking into edit
  mode (#78).** Previously the only way to view a long cell's untruncated
  content was to double-click, which for an editable cell also entered
  inline-edit mode — an unwanted side effect when the user only wanted to
  _read_ the value. The `DataGrid` cell renderer's plain (non-editing)
  branch now checks whether the cell matches `selectedCell` (set on plain
  single click, compared by the same `rowValues`/`row.original` referential
  identity used everywhere else in the grid — see gotcha #7) and, if so,
  renders a small `Maximize2` button next to the value. Clicking it calls
  the existing `openHeavyEditor`, unchanged, so it already honours the
  user's `cellEditorMode` preference (modal vs. docked side panel) exactly
  like the inline editor's own expand button and the cell-preview panel's
  fullscreen button do. The icon appears uniformly for text, FK and BIT
  columns, and for read-only query results — it is purely a value viewer,
  never an editor, so no column type needs excluding.

- **Ctrl+C / Ctrl+V now work on the selected data-grid cell (#79).**
  `handleGridKeyDown` used to deliberately ignore every Ctrl/Cmd-modified
  key chord (to avoid interfering with the browser's own copy/paste), which
  meant Ctrl+C over a cell copied nothing, since a `<td>` has no native text
  selection to copy from. Ctrl+C and Ctrl+V are now special-cased ahead of
  that blanket guard: Ctrl+C copies the raw value of the mouse-selected cell
  (falling back to the keyboard-navigated active cell when nothing has been
  clicked) via the same `copyToClipboard` helper the right-click "Copy"
  context-menu item already uses. Ctrl+V reads `navigator.clipboard`, and
  seeds `inlineEdit` with the pasted text instead of the cell's current
  value — reusing the exact same `CellInput` commit/cancel flow as a normal
  double-click edit, so Enter/blur saves the pasted value and Escape
  discards it. FK and BIT columns have no free-text control to paste into
  (they use a combobox / `<select>` instead), so paste is a deliberate
  no-op there for now; copy still works on every column type.

- **Keyboard shortcuts are now customizable from Settings → Shortcuts
  (#75), unblocking the hotkey half of #78.** Issue #78 asked for a hotkey
  alternative to the expand-icon added above, since the icon's low contrast
  makes it easy to miss — but explicitly deferred that to #75 first. Six
  actions are now rebindable: `openSettings` (Ctrl/Cmd+,),
  `toggleCommandPalette` (Ctrl/Cmd+K), `toggleTabSwitcher` (Ctrl/Cmd+P),
  `refreshData` (F5 — Ctrl/Cmd+R remains a permanent, non-rebindable alias,
  since suppressing the WebView's native reload is a safety necessity, not
  a preference), `runQuery` (Ctrl+Enter), and the new `expandSelectedCell`
  (default `Space`, mirroring macOS Quick Look — confirmed unbound in
  `handleGridKeyDown` today, so it lands with zero collision). Overrides
  persist through `prefs.json` as a new `keybindings` map (action id →
  combo string), following the exact pattern already used by `grid`/`editor`/
  `ui` prefs — an empty map is a fully valid state, since the frontend's new
  `ACTIONS` table in `lib/keybindings.ts` is the single source of truth for
  defaults. `App.tsx`'s global `keydown` listener and `DataGrid`'s
  `handleGridKeyDown` now match against the live binding via a shared
  `matchesBinding` helper instead of hardcoded `e.key`/`e.ctrlKey` checks —
  which incidentally fixes a latent bug where `Ctrl+Shift+K` was
  indistinguishable from plain `Ctrl+K` (no branch checked `shiftKey`).
  Monaco's `editor.addCommand`, used for `runQuery`/`toggleCommandPalette`/
  `toggleTabSwitcher` inside the SQL and view editors, resolves a fixed
  keybinding bitmask once at registration time with no way to re-check a
  live combo — so those three moved to `editor.onKeyDown`
  (`registerEditorActionRedispatch` in the new `lib/monacoKeybindings.ts`),
  which reads the current binding from the store on every keystroke. The
  Settings UI (`ShortcutsSection`/new `ShortcutRow`) replaces the old
  read-only placeholder: clicking a row enters a "press a key…" capture
  mode (Escape always cancels rather than becoming the binding), a rebind
  that collides with another action's combo is rejected inline instead of
  silently swapping or unbinding anything, and each row plus a "Reset all"
  button can restore the default. `expandSelectedCell` reuses the exact
  same `resolveTargetCell()`/`openHeavyEditor()` pair the expand icon's
  click handler already calls, so the icon and the hotkey converge on one
  escalation path. Also bumped both expand icons'
  (`DataGrid`/`CellInput`) contrast from `text-muted-foreground/50` to
  `/80` so the icon added in #78 doesn't require a hover to notice.

### Fixed

- **MySQL spatial columns (`POINT`, `MULTIPOINT`, …) were misclassified as
  numeric by the Advanced Filter**, because `isNumericType`'s substring check
  for `"int"` also matches inside the word `"point"`. Those columns lost
  `contains`/`starts_with`/`ends_with` and gained meaningless `>`/`<`
  comparisons. Found while auditing operator unification for #81; fixed by
  excluding the `"point"` substring from the `"int"` check.

- **The MCP connector's write tools could be forced into read-only for a
  MongoDB database they had explicit `data`/`full` access to.** Reported by a
  user hitting `has MCP write policy "read-only"` on `update_cell` against a
  connection whose Settings → MCP level was actually `data`. The write gate
  (`Huginn::require_class`) was checking the policy against
  `resolve_mongo_target`'s _resolved_ pool id rather than the real profile id.
  For a multi-database Mongo connection (empty top-level `database` — the
  common case, since HuginnDB doesn't require picking one at connect time), a
  tool call naming a `schema`/`database` resolves to the synthetic
  per-database id `<connection_id>::db::<name>` so it can address the right
  live pool — but that synthetic id is never a key in `profiles.json`, so the
  policy lookup silently missed and fell back to the default `ReadOnly`,
  regardless of what the connection was actually configured to. `run_query`,
  `insert_row`, `update_cell` and `delete_rows` now gate on `a.connection_id`
  (the real profile id) instead of the resolved target; the resolved target
  is still used, as before, to find the right pool. Added a regression test
  reproducing the exact scenario (a `data`-policy Mongo connection with no
  default database, addressed via `schema`).

- **`updateMany`/`updateOne` rejected an aggregation-pipeline update
  (`db.coll.updateMany(filter, [{ $set: {...} }])`)** with `argument 2 must be
a document`, even though the underlying `mongodb` driver has supported
  pipeline-style updates since server 4.2. The mongosh-style parser
  (`db/mongo/shell.rs`) only ever built a plain `Document` for the `update`
  argument. It now accepts either shape — a new `UpdateSpec` enum
  (`Document` | `Pipeline`) mirroring `mongodb::options::UpdateModifications`
  — so pipeline updates (e.g. `$replaceAll`/`$toUpper`/computed field values
  that reference other fields) work through `run_query` the same as they do
  in `mongosh`.

### Security

- **Manually verified the MCP connector's write-policy gate end-to-end
  against a real profile set, using an actual AI client (Claude Code driving
  `huginndb-mcp`) rather than a unit test.** `list_connections` was called
  first, read-only (no state touched): of every exposed connection —
  production databases and real client sandboxes included — exactly one
  (an internal ITBacking test server) carried `mcp_write: "data"`; every
  other connection sat at the safe `read-only` default, exactly as
  `McpWritePolicy::default()` (`state.rs`) guarantees for any profile that
  never had a level explicitly raised in Settings → MCP. An `insert_row`
  call was then attempted against that one `data`-policy connection, on a
  connection-less config table (no customer data, no foreign keys) — the
  lowest-risk target available — as a full round-trip check (insert, verify,
  update, delete, leaving no residue). The write never reached
  `Huginn::require_class`: Claude Code's own tool-permission layer (the
  client driving the MCP session, not code in this repo) intercepted the
  call and withheld it pending explicit user authorization, even though the
  server-side policy would have allowed it. This confirms the two gates are
  independent and both intact — a permissive per-connection `mcp_write`
  policy is necessary but not sufficient; the calling AI client's own
  action-approval prompt is a second, separate backstop, not a
  redundant/interchangeable one. No code changes resulted; this is a release
  checklist entry, not a fix.

## [1.9.1] — 2026-07-22

### Fixed

- **Running a single INSERT/UPDATE/DELETE showed no feedback (#82).** The
  query editor's single-statement path (`Ctrl+Enter`) rendered a columns-less
  DML result straight into `DataGrid`, which has nothing to draw for it — the
  results panel just looked empty, with no error and no row count. Only the
  multi-statement batch path ever showed a "rows affected" summary. A DML
  result (no columns) now shows a small "N rows affected · Xms" banner
  instead, on every SQL driver — this wasn't actually MySQL-specific, just
  more likely to be noticed there.

- **The MCP connector's write tools could make new client sessions see zero
  tools (#83).** The write-mode tools added for `insert_row`, `update_cell`
  and `delete_rows` introduced JSON-schema shapes never used before in this
  server's `tools/list` output: a nested struct hoisted into `$defs`/`$ref`,
  and PK-value fields whose per-item schema was the bare boolean `true`
  (schemars' representation of "any JSON value"). Both are valid JSON Schema,
  but an MCP client whose `tools/list` ingestion assumes every schema node is
  a plain object can throw on them — and if that ingestion wraps the whole
  tool list in one try/catch, a single malformed-for-that-client schema
  silently drops all 12 tools for the session, while the server's own log
  (which only reflects what it sent) looks perfectly healthy. The three
  tools' schemas are now inlined and hand-constrained to
  `string | number | boolean | null`, with a regression test asserting no
  `$ref`/`$defs`/bare-boolean subschema ever reappears.

- **Expanding a same-named database under a different connection could leak
  the previous connection's data (#76).** The multi-database schema tree
  keyed its `DatabaseRoot` nodes by database name alone; because nothing
  remounts that tree when the active connection changes, React reused the
  same component instance — and its locally-cached pool id — for two
  different connections that both happened to expose a database with the
  same name (e.g. a `shop` database on both a MySQL and a MongoDB profile).
  The second connection's node kept rendering the first connection's tables.
  The node is now keyed by connection + database name together, so switching
  connections always gets a fresh instance.

- **Window/split layout and in-progress tab edits could be lost on close
  (#80).** No window-close hook ever flushed the debounced tab/layout state
  to disk, and a pure split/float/resize gesture didn't schedule a save at
  all (only a tab or schema change did) — so a normal window close, not just
  a crash, could drop the last ~600ms of edits, including split-panel
  geometry set up moments earlier. Closing the main window now flushes every
  active connection's tab state synchronously first, and layout changes
  schedule a save the same way tab changes already did.

- **MongoDB activity never reached the Console.** Browsing a collection
  (`fetch_table_data`) and running a multi-statement mongosh batch
  (`execute_batch`) both delegated straight to the Mongo driver module
  without ever building a log entry — unlike the single-statement path,
  insert/update/delete, which already logged correctly. Every other driver
  logged every read and write; MongoDB only logged writes issued one
  statement at a time. Collection browsing now logs a reconstructed
  `db.<collection>.find(filter).sort().skip().limit()` line (there's no
  literal statement to echo the way a hand-typed one has), and each
  statement in a mongosh batch logs individually, same as the SQL batch path.

- **The advanced filter builder silently returned nothing on MongoDB when
  filtering a numeric (or boolean) field.** The right-click "Filter by this
  value" chip sends the cell's already-typed value (e.g. the JS number
  `183`), but the advanced-filter dialog's value input is a plain text box —
  it always sent the typed-in text as a JSON string. Postgres/MySQL/SQLite
  don't notice: an unbound parameter's type is inferred from the column it's
  compared against, so a text `"183"` still matches an `integer` column.
  MongoDB's equality is exact-BSON-type, though, and a `string` `"183"`
  never matches a stored `int32` 183 — so the identical filter that worked
  from the context menu returned zero rows from the dialog. The dialog now
  coerces the typed value to a number/boolean based on the column's type
  before applying the filter (substring-match operators — contains/starts
  with/ends with — keep the raw text, since those are always a text/regex
  match regardless of column type).

## [1.9.0] — 2026-07-20

### Fixed

- **Console logs leaked across windows (#50).** With a second window open (the
  "New window" action), every window's Console showed every other window's
  SQL and connection entries. The backend already targeted log events at the
  originating window, but the frontend listener wasn't scoped, so Tauri
  delivered all of them to every window. Each window's Console now shows only
  its own activity; genuinely global notices (like a shared connection dropping)
  still reach every window.

- **MySQL boolean columns showed `NULL` instead of their value (#68).** A
  `TINYINT(1)` / `BOOL` / `BOOLEAN` column is reported by the driver under the
  type name `BOOLEAN`, which the value decoder didn't recognise as an integer —
  so every boolean cell fell through to a text decode that isn't valid for the
  column and collapsed to `NULL`. Boolean columns now render their stored value
  (`0` / `1`), like any other integer.

### Added

- **Advanced per-column filter (#66).** A new filter button in the data-grid
  toolbar opens a builder where you add conditions per column — column →
  operator → value — all combined with AND and applied server-side. Operators
  are type-aware: text columns offer contains / does-not-contain / starts-with
  / ends-with, numeric and date columns offer ordered comparisons
  (>, ≥, <, ≤), and every column offers equals / not-equals / is-null /
  is-not-null. Works across Postgres, MySQL, SQLite (SQL `LIKE`/comparisons)
  and MongoDB (regex / `$gt`…`$lt`). The button shows a badge with the active
  condition count.

- **Empty a table from the schema explorer (#69).** A new "Empty table" entry
  in a table's (or MongoDB collection's) context menu removes every row while
  keeping the table and its structure — handy for tables used as logs. It uses
  `TRUNCATE` on Postgres/MySQL, `DELETE FROM` on SQLite, and `deleteMany({})`
  on MongoDB. A confirmation dialog guards the action and carries a "don't ask
  again" checkbox backed by a dedicated `confirmEmptyTable` preference, so
  silencing it never weakens other destructive confirmations.

- **MCP connector write-mode, with a per-connection permission model.** The
  headless `huginndb-mcp` connector, read-only since 1.7.0, can now perform
  writes — governed per connection, not by a single global switch. Each
  connection carries a **write policy** set in Settings → MCP:
  - `read-only` (default) — only reads succeed;
  - `data` — adds row-level DML (`INSERT`/`UPDATE`/`DELETE`) via `run_query`
    plus the new `insert_row` / `update_cell` / `delete_rows` tools;
  - `full` — also allows DDL (`CREATE`/`DROP`/`ALTER`/…) via `run_query`.

  The policy is re-read from `profiles.json` on every write attempt, so
  changing a connection's level takes effect without restarting the AI client.
  Because the sidecar is a headless process that can't show a prompt, the
  per-action approval stays with the MCP client, and HuginnDB records every
  write (success or failure) to `mcp-audit.log` alongside your profiles. A
  whole-table `UPDATE`/`DELETE` with no `WHERE` is refused outright, and a new
  `--read-only` flag forces every connection read-only regardless of its saved
  policy. The old `--allow-writes` flag is deprecated and inert. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.8.3] — 2026-07-16

### Added

- **Create a MongoDB collection from the explorer (#61).** MongoDB creates a
  collection implicitly on first write, so there was no way to materialize an
  empty collection from the UI — you had to insert a document first. A "New
  collection" entry now sits in the MongoDB database context menu (and a "+"
  button in the single-database toolbar, mirroring the Postgres/MySQL "New
  database" affordance), issuing an explicit `create` command via a new
  `create_collection` backend command so the collection appears in the tree
  before any document exists, matching MongoDB Compass. The name is validated
  (non-empty, no reserved `system.` prefix); non-Mongo drivers are rejected
  (they create tables through the structure editor).
- **Choose which databases a connection shows, DataGrip-style (#64).** A
  multi-database connection listed _every_ database on the server and warmed
  all of them in the background — noisy and slow on servers with dozens of
  databases. A new checklist (the list-checks button in the multi-DB explorer
  header) lets you pick the subset you actually work with; the explorer then
  renders only those and, crucially, scopes the background prefetch to them so
  connecting to a big server no longer fans out across everything. The choice
  persists per connection (`visible_databases` on the profile; `null` = show
  all, so newly-created databases keep appearing automatically). Applies to
  Postgres/MySQL and MongoDB clusters alike.
- **Import and export MongoDB collections as JSON (#65).** The whole-database
  `.sql` export never supported MongoDB. Each collection now has "Export
  collection (JSON)…" / "Import JSON…" in its context menu, using **canonical
  MongoDB Extended JSON** so `ObjectId`/`Date`/`Decimal128`/… round-trip with
  their types intact (unlike the display form the grid shows). Export streams
  straight from the cursor to the file; import accepts a JSON array, a single
  object, or newline-delimited JSON (mongoexport's default) and `insert_many`s
  the batch after a destructive-action confirmation.

### Changed

- **The OS window title now reflects the active connection and table (#57,
  #59).** Every window was titled a static "HuginnDB", making multiple windows
  impossible to tell apart from the taskbar / Alt-Tab. The title now shows
  `<profile> · <database>.<table> — HuginnDB` for the active table tab (falling
  back to `<profile> · <database>` for other tabs, and plain "HuginnDB" when
  nothing is connected), and table tabs themselves are labelled `database.table`
  instead of just the table name, so the database and table are always shown
  together. The redundant `schema › table` breadcrumb that used to sit next to
  the data-grid filter is gone — the tab title already carries that identity.
  Secondary windows are covered by the capability config (`win-*`), which also
  gives them the window permissions they need in general.
- **Connecting to a many-database server is now instant — the explorer no
  longer eagerly caches every database's tables on connect.** The multi-DB
  explorer used to warm the table list of _every_ database in the background
  right after connecting, so a connection with 19+ databases sat visibly
  "Caching schema… n/m" for a moment before settling. That eager warm was only
  ever a search optimization, and it is now redundant with the visible-databases
  selector (#64) and the active-database scope: databases load lazily when
  expanded, and the cross-database search still fans out on demand the first
  time you search. Net effect: connect is immediate regardless of how many
  databases the server has; the only trade is that the first cross-database
  search after connecting is served cold.

## [1.8.2] — 2026-07-15

### Added

- **The self-updater now catches up on releases published while the app
  stays open, instead of only checking on launch.** `checkOnLaunch` used to
  be the only trigger — an instance nobody ever closes (a shared machine, a
  workstation that's never rebooted) could sit on the previous version
  indefinitely no matter how many releases were published, since publishing
  was never the missing piece — the app just never asked again. A new
  `startPeriodicChecks` (`src/stores/update.ts`) re-runs the same check every
  4 hours for the lifetime of the running app, so a long-lived instance
  eventually notices on its own. Paired with that: the installer download
  now starts silently in the background the moment an update is detected
  (`startBackgroundDownload`), so by the time anyone actually notices the
  banner, installing is instant instead of waiting on a fresh download. The
  one thing this deliberately does **not** automate is `install()` itself —
  the step that overwrites files, force-kills the `huginndb-mcp` sidecar
  (gotcha #23), and can prompt Windows for elevation — which only ever runs
  off an explicit "Install" / "Restart now" click, never unattended. A new
  `readyToRestart` status distinguishes "downloaded, one click from done"
  from "still fetching" in both the top banner and Settings → About.
  Because installing force-kills the MCP sidecar, `installAndRelaunch` also
  checks whether it's currently running (a new `is_mcp_sidecar_running`
  Tauri command — a `tasklist`/`pgrep` shell-out, no new dependency) and, if
  so, confirms with the user first instead of silently yanking a connection
  an AI client might be mid-use of.
- **Documented Cursor and Antigravity as MCP clients, and improved the
  Settings → MCP connections list.** `huginndb-mcp` is a plain stdio MCP
  server with no client-specific code, so it already worked with any
  spec-compliant client — Cursor and Google's Antigravity IDE included — the
  gap was that `docs/MCP.md` only spelled out Claude Code, Claude Desktop,
  and Codex, leaving users of other agentic IDEs to guess at config file
  locations and JSON shapes. Added dedicated sections for both: Cursor's
  `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global), and
  Antigravity's UI-driven "Manage MCP Servers → View raw config" flow — both
  documented as using the exact same `mcpServers`/`command`/`args` shape the
  app's Settings → MCP panel already generates, so the existing JSON snippet
  pastes in as-is. Separately, the connections list in Settings → MCP now has
  a name filter and a "select all / deselect all" button (scoped to the
  currently filtered rows) plus a live `n of m selected` count — the flat
  checkbox list didn't scale past a handful of saved connections.
- **`docs/MCP.md` now has a maintained Spanish translation
  (`docs/MCP.es.md`).** The in-app Documentation viewer (Help → Documentation)
  bundled the MCP guide in English only, regardless of the user's chosen UI
  language — inconsistent with the rest of the app, which already ships full
  Spanish strings and a Spanish `CHANGELOG.es.md`. `src/lib/docs.ts` now keeps
  a per-language `bodies` map per doc entry (English always present) and
  `getDocBody` falls back to English when a translation is missing, mirroring
  `getReleases` in `lib/changelog.ts` — the same "English authoritative,
  Spanish may lag" contract used for the changelog.

## [1.8.1] — 2026-07-15

### Fixed

- **Updating on Windows while an MCP client had the `huginndb-mcp` sidecar
  running could fail with a spurious permissions error.** The NSIS installer
  stays on Tauri's default `currentUser` install mode (writes under
  `%LOCALAPPDATA%`, no elevation needed), and correctly closes a running
  `huginndb.exe` before overwriting it — but it had no idea `huginndb-mcp.exe`
  exists, since that process is spawned independently by whatever external
  MCP client has it configured (Claude Desktop, Claude Code, ...), never by
  HuginnDB itself. If a client still held it open during an in-app update,
  Windows locked the file and the overwrite failed with
  `ERROR_SHARING_VIOLATION`, surfaced to the user as a generic access-denied
  error even though no admin permissions were actually missing. A new
  `NSIS_HOOK_PREINSTALL` installer hook (`src-tauri/windows/hooks.nsi`) now
  force-closes the sidecar before any files are copied; the MCP client just
  respawns it the next time it needs the connector.
- **`huginndb-mcp` rejected SQLite and password-less MongoDB connections with
  "no stored password for keychain account ...::".** The desktop app's
  `resolve_password` helper already knows SQLite never stores a password
  (there's nothing to authenticate — it's a local file) and that MongoDB's
  is optional (it may be embedded in the connection URI, or the server may
  allow unauthenticated access), falling back to an empty string in both
  cases. The MCP server's `ensure_connected` never reused that helper — it
  called `keychain::require_password` directly, so any SQLite or bare-URI
  MongoDB connection exposed to an MCP client failed every tool call with a
  spurious "missing credential" error, even though nothing was actually
  missing. It now calls the same `resolve_password` the desktop app uses.

## [1.8.0] — 2026-07-14

### Fixed

- **MongoDB Security panel works on multi-database connections.** The 1.7.0 fix
  for #52 taught `list_collections` to return an empty list at the cluster
  level instead of erroring, but `list_users`/`list_privileges` were never
  updated the same way — opening the Security tab on a MongoDB connection with
  no preselected database still threw "no database selected". Both now run
  cluster-wide via the `usersInfo` command with `forAllDBs: true` against the
  `admin` database when no database is selected (the same cluster-level
  pattern the connection health-check ping already used), falling back to the
  existing per-database behavior otherwise.
- **MCP `run_query` no longer rejects every MongoDB query.** The read-only
  guard reused the plain-SQL keyword classifier (`select`/`with`/`show`/
  `explain`/`pragma`), which a mongosh statement like `db.coll.find({...})`
  never matches — so any MongoDB read submitted through `huginndb-mcp`'s
  `run_query` tool was rejected by default, with the only escape hatch being
  the server-wide `--allow-writes` flag (which also unlocks real SQL writes on
  every other exposed connection). The desktop query editor never had this
  problem because it classifies Mongo statements with `MongoOp::is_read()`
  before the generic gate runs; `run_query` now does the same.
- **MCP tools can target a database on a multi-database MongoDB connection.**
  `list_tables`, `describe_table`, `list_indexes`, and `browse_table` accepted
  a `schema` parameter that was silently ignored for MongoDB — every call on a
  database-less connection failed with "no database selected", with no way to
  say which database to use, and `run_query` had no way to target one for a
  bare `db.coll.find()` either. The desktop app solves the equivalent problem
  by opening a synthetic per-database pool when a user expands a database in
  the schema explorer; that logic needed no Tauri `AppHandle`/`Window` to
  begin with, so it's now shared with the MCP server, which resolves the same
  per-database pool whenever `schema` (or `run_query`'s new `database`
  parameter) names a database on a connection with none bound.
- **`browse_table`'s `limit`/`offset` accept a numeric string.** Some MCP
  clients serialize integer arguments as JSON strings despite the advertised
  schema; both fields now parse either a JSON number or a numeric string
  instead of rejecting the call outright.

### Added

- **Real per-column BSON types in MongoDB query/browse results.** `run_query`,
  `browse_table`, and the data grid used to label every column with a generic
  `"bson"` type, even though each field has a concrete BSON type. Columns now
  report the actual type inferred from the returned documents/values (`int`,
  `string`, `date`, `objectId`, …), falling back to `"mixed"` when a field's
  non-null values disagree in type across the result set — an honest answer
  rather than silently picking one. This also gives AI tools using the MCP
  connector a real type signal instead of none.
- **Collection size in the MongoDB explorer.** Collections previously always
  showed an unknown size. A single `$collStats` aggregation run at the
  database level now returns storage stats for every collection in one round
  trip (rather than one `collStats` call per collection), so the explorer can
  show an on-disk size the same way the SQL drivers do.

## [1.7.1] — 2026-07-14

### Added

- **`huginndb-mcp` now ships bundled with the installer, and Settings gained
  an MCP panel.** Previously the connector was reachable only by cloning the
  repo and building it yourself — no packaged install ever included the
  binary. It's now a Tauri sidecar (`bundle.externalBin`), installed
  side-by-side with the main executable, and the release workflow builds and
  stages it automatically. **Settings → MCP** resolves that path, lets you
  pick which saved connections to expose, and generates a ready-to-paste
  `claude mcp add`/JSON snippet — no more hunting through install
  directories or `profiles.json` for connection ids by hand. See
  [`docs/MCP.md`](docs/MCP.md).

## [1.7.0] — 2026-07-14

### Added

- **MCP connector (`huginndb-mcp`).** A headless, read-only [Model Context
  Protocol](https://modelcontextprotocol.io) server that exposes the databases
  HuginnDB already knows about — profiles from `profiles.json`, passwords from
  the OS keychain — to AI coding tools (Claude Code, Claude Desktop, Cursor, …)
  over stdio, so an assistant can inspect real schema and data instead of
  guessing. It is a separate process from the desktop app, opens pools lazily,
  and is **opt-in per profile** (`--connections <id>`): nothing is reachable
  until you name it. Read-only by default (`run_query` rejects non-read-only
  SQL; no write tools), with a `--max-rows` cap (default 1000). Ten tools:
  `list_connections`, `list_databases`, `list_tables`, `describe_table`,
  `list_indexes`, `run_query`, `browse_table`, `server_version`, `list_users`,
  `list_privileges`. Built behind an optional `mcp` cargo feature
  (`cargo build --features mcp --bin huginndb-mcp`), so a normal
  `pnpm tauri:build` is unaffected. See [`docs/MCP.md`](docs/MCP.md).

### Fixed

- **Multi-database connections now show a name in the title bar (#51).** The
  centred breadcrumb rendered the connection's catalog directly, so a
  multi-database connection (no single preselected database) left the middle
  segment blank. It now falls back to the connection name when there is no
  single database.
- **The docked side editor no longer keeps a value from another table (#49).**
  Opening a cell in the side editor and then switching to a different tab left
  the old value on screen even though you were looking at an unrelated table.
  The panel is now scoped to the tab that opened the cell: it clears when you
  switch away (unless the buffer has unsaved edits, which are preserved so a
  tab switch never drops your work).
- **The column-resize guideline lands on the real column edge (#46).** The live
  guideline was positioned from TanStack's nominal column widths, but the grid
  uses a `table-fixed`/full-width layout that stretches columns past those
  widths when they don't fill the viewport, so the guideline drifted left of
  the actual edge (the error grew per column). It now measures the resizing
  header's rendered position.
- **MongoDB connections open without a preselected database (#52).** Opening a
  MongoDB connection in multi-database mode failed with a driver error because
  listing collections required a selected database, which blanked the whole
  tree. Listing collections at the cluster level now returns empty (as the SQL
  drivers already do), so the database list renders and you can expand into a
  specific database as before.
- **New windows are independent from the main window (#50).** "New window"
  opened a window that adopted the main window's live connection — it appeared
  connected without the user opening anything, contradicting the per-window
  independence introduced in 1.4.0. The set of open connections is now
  per-window: a window shows a connection as active only when it opens the pool
  itself. Shared configuration (saved profiles and preferences) still syncs
  across windows, and a connection closed in one window is still cleaned up in
  the others that had it open.

### Changed

- **Windows installer switched from MSI (WiX v3) to NSIS.** The release build
  started failing to bundle the `.msi` on GitHub's Windows runners — WiX v3
  has been unmaintained/archived since February 2025, and its `light.exe`
  reliably failed to even launch on the current runner fleet regardless of OS
  image (Windows Server 2022 or 2025), with no error detail beyond a bare
  process-launch failure. Tauri officially supports MSI → NSIS as an update
  path (the reverse is not supported) and the bundled `tauri-cli` here
  (2.11.1) already includes NSIS's detection of a prior MSI install. Existing
  installs auto-update to a `-setup.exe` instead of a `.msi`; the installed
  app itself is unaffected.
- **`huginndb-mcp` moved to its own workspace crate (`src-tauri/mcp-server/`).**
  The NSIS switch above then hit a second, unrelated bundler issue: with more
  than one `[[bin]]` in a package, `tauri-bundler` tries to size/bundle every
  declared binary regardless of feature gating, so it went looking for a
  `huginndb-mcp` build artifact that a normal `pnpm tauri:build` never
  produces. Moving the (already-thin) binary shim to a sibling crate keeps it
  entirely out of the app's own `cargo metadata`. Build it with
  `cargo build -p huginndb-mcp --release` from `src-tauri/` — see
  [`docs/MCP.md`](docs/MCP.md).

## [1.6.1] — 2026-07-10

### Added

- **Searchable, grouped, multi-select connections manager (#39, #43, #40).**
  The manager's left rail was a flat single-select list that got unwieldy past
  a handful of connections. It now:
  - has a **search box** filtering by name, host, database, group, or URI;
  - renders connections as a **folder tree** (grouped by the `group` field)
    with collapsible group headers — an active search force-expands so matches
    are always visible;
  - supports **multi-selection** (Ctrl/Cmd-click to toggle, Shift-click for a
    range, plus per-row checkboxes on hover) with a **bulk delete** that always
    asks for confirmation, regardless of the "confirm destructive actions"
    preference.
- **Duplicate connection (#38).** The connections manager gained a _Duplicate_
  action that clones the selected profile into a fresh draft with a uniquified
  name ("… (copy)"), ready to tweak and save. The password is intentionally not
  carried over — credentials are keyed by profile id in the OS keychain and the
  clone gets a new id — so a banner reminds you to re-enter it before
  connecting.
- **Configurable connection-group expand mode (#40).** A new General preference
  (`Connection groups`) controls how folder groups start out in the File menu
  and the connections manager — _always expanded_, _always collapsed_, or
  _remember per group_ (the previous behaviour). The File menu's groups are now
  collapsible too, matching the status-bar switcher.

- **Brand logos in the driver dropdown.** The connection editor's driver
  selector now shows each database's official logo next to its name (both in
  the trigger and the options), reusing the bundled `DriverBadge` marks already
  used elsewhere, instead of a bare list of names.
- **Live guideline while resizing data-grid columns (#42).** Dragging a column
  edge now shows a full-height vertical guideline that tracks the pointer, so
  you can see the target width before releasing instead of eyeballing it
  against the neighbouring column. The width still commits on release (the
  existing deferred, per-table-persisted behaviour).

### Fixed

- **The docked side editor now closes when its source tab closes.** The
  JetBrains-style side editor lives outside any tab's subtree, so opening a
  cell in it and then closing that table's tab left it lingering with a stale
  value, waiting for a manual discard. The cell now records its owning tab and
  the panel closes itself when that tab (or its connection) goes away.
- **Cell editor undo no longer reaches into the previously-edited cell.** The
  docked side editor (and the modal) reused a single Monaco model across cells,
  so after editing one row, selecting the same column on another row and
  pressing Ctrl+Z restored the _previous_ row's value. Monaco is now remounted
  with a fresh, empty undo stack on each cell load, so undo stays scoped to the
  current editing session; typing within a cell still undoes normally.
- **Boolean BIT cell picker no longer collapses on open (#44).** Editing an
  existing row's BIT column (with BIT shown as boolean) opened the native
  `<select>` but it snapped shut the instant you clicked an option: the cell's
  `onClick` refocused the scroll container, stealing focus from the dropdown.
  The cell now yields clicks to its own inline editor while one is active.
- **Opening a table no longer runs COUNT + SELECT twice (#41).** Two things
  doubled the initial fetch: the callback depended on `searchColumns` (derived
  from the async-loaded column list, so it changed identity and re-ran the
  effect once columns arrived), and React StrictMode double-invokes effects in
  dev. `searchColumns` is now read through a ref, and the fetch dedupes on the
  wire — a byte-identical request already in flight is skipped — so a table
  open issues exactly one COUNT + SELECT in both dev and production.

## [1.6.0] — 2026-07-08

### Added

- **Legible show/hide toggle on every password field.** WebView2 draws a
  native password-reveal eye that can't be themed and renders near-black —
  effectively invisible on dark surfaces. It's now hidden app-wide and
  replaced by a themed `PasswordInput` toggle (muted → foreground on hover,
  bilingual label). Applied to all secret fields: connection password, SSH
  password / passphrase, the export & import passphrases, the connect-time
  password prompt, and the GitHub token in the feedback dialog.

- **Tab management overhaul.** With many tabs open it was hard to tell what
  you had open or jump to a specific table. Four additions address that:
  - **Open-tabs quick switcher (Ctrl/Cmd+P).** A keyboard-first overlay
    listing _currently open_ tabs across every connection, grouped pinned-first
    then by `connection · database`. Search by name, navigate with the arrows,
    Enter jumps (and points the workspace at that tab's connection), and each
    row pins/unpins or closes inline (Delete closes the highlighted one).
    Distinct from the command palette (Ctrl+K), which opens _new_ things.
  - **Open-table markers in the schema tree.** Every table that's open in a
    tab now shows a soft brand dot in the tree — not just the active one — so
    you can see at a glance what you already have open while browsing.
  - **Tab-strip switcher button** with a live open-tab count, doubling as the
    overflow affordance when tabs don't all fit.
  - **The active tab is always scrolled into view.** Opening a table when the
    strip was already full left the new (active) tab clipped behind the
    overflow ∨ / switcher / "+" controls — dockview scrolls the active tab in,
    but does so before our custom tab content has laid out, so the new tab was
    left hidden. The active tab now scrolls itself fully into view once its
    content is painted.
  - **Pinning + richer bulk-close.** Tabs can be pinned (⋮ / right-click, or
    from the switcher) so they survive "close others / all / to the right";
    pinned tabs carry a pin marker and group first in the switcher. The tab
    menus gained "Close tabs to the right" and "Close others in this
    connection". Pins persist per connection across restarts.
- **"What's new" presentation after an update.** The first launch after an
  update bumps the app to a release flagged `major` now pops a curated,
  iconified highlights dialog (the punchy counterpart to the exhaustive
  changelog in Settings → About). Content is a hand-authored, bundled
  catalogue in `src/lib/releaseNotes.ts` with bilingual copy in i18n; the
  seen-marker is persisted in `localStorage` (mirroring the update store) so
  it fires exactly once per major release, main-window only. Reachable any
  time from Help → "What's new". When cutting a `major` release, add its entry
  (matching the manifest version exactly) and flag it `major`.
- **Visible Run button in the query editor (UI/UX overhaul, phase 2).** The
  editor's primary action had no button at all — it was Ctrl+Enter and a
  per-statement CodeLens only, with a "Run all" that appeared conditionally. A
  brand-filled Run button now leads the toolbar with a Ctrl/⌘+Enter shortcut
  chip, runs the whole buffer (routing to the batch runner when it holds more
  than one statement), and shows a spinner while executing. Save / history are
  demoted behind a divider.
- **Schema tree redesign (UI/UX overhaul, phase 1).** The left database/table
  tree gained clear hierarchy and orientation. The currently-open table is now
  marked in the tree — a soft brand wash plus a 2px inset brand rail, driven by
  the active tab — so you can always see "where you are". The table name is the
  boldest element on its row (foreground / medium weight) against the muted
  section labels and column rows, column data types are colour-coded (numeric
  amber / boolean green / others muted, reusing the grid's semantic hues), and a
  table's columns load behind a shimmer skeleton instead of an italic
  "loading…" line. Column indentation follows a consistent 12px-per-level
  ladder (schema → section → table) with a continuous depth-guide hairline that
  drops from under each open table's chevron, and table metric badges use
  tabular figures. The single-database "database created" confirmation is now a
  themed toast instead of a native `alert()`.
- **Keyboard navigation in the data grid (UI/UX overhaul, phase 1).** The grid
  was mouse-only, at odds with the app's keyboard-first identity. Cells now
  carry a keyboard-navigable "active cell" marked with an inset `brand` ring:
  arrow keys move it, Home / End jump to the row's first / last column, Enter
  opens the cell editor (inline / FK combobox / modal, same routing as
  double-click) and Escape clears it. Clicking a cell seeds the active cell so
  the keyboard picks up from there, and the active cell scrolls into view as it
  moves (instantly — the indicator never animates, since it tracks every
  keypress).
- **Visible row-selection checkboxes in the data grid (UI/UX overhaul, phase 1).**
  Multi-row selection already worked via Ctrl/Cmd- and Shift-click, but there
  was no visible affordance — the `#` gutter only ever showed the row number, so
  the feature was undiscoverable. The gutter now renders a tri-state select-all
  checkbox in the header (checked / indeterminate / empty over the visible rows)
  and a per-row checkbox that appears on row hover and stays while the row is
  selected. Both are backed by the existing PK-keyed selection set (survives
  sort / filter / refetch) and tinted with the `brand` token; row numbers now
  use `tabular-nums`.
- **Export and import whole databases (#34), marked Beta.** No way to get a database out
  of HuginnDB (or back in) short of scripting it by hand. "Export database…"
  (multi-DB explorer context menu, or a toolbar button on a single-DB
  connection) dumps schema + data to one portable `.sql` file for
  Postgres, MySQL, or SQLite. Postgres/MySQL write in three phases — bare
  `CREATE TABLE`, then all data, then `ALTER TABLE ADD CONSTRAINT` (FK) +
  `CREATE INDEX` — so a whole-database dump never needs a table-dependency
  topological sort and never needs elevated privileges (e.g. Postgres's
  superuser-only `session_replication_role`). SQLite instead dumps its
  catalog verbatim from `sqlite_master` (higher fidelity than reconstructing
  DDL — it keeps `CHECK` constraints etc.) bracketed by
  `PRAGMA foreign_keys=OFF/ON`. "Import .sql…" picks a file and runs it
  through the _existing_ query batch runner (the same `splitSql` +
  `execute_batch` path the query editor already uses) instead of a second
  execution path, gated behind the destructive-action confirmation. Labelled
  Beta in the UI — verified by type-checking and `cargo check` only so far,
  not yet exercised end-to-end against a live server on all three drivers.
- **Free-form tab colour, and a selectable accent style (#35).** The tab
  colour picker offered only six fixed swatches; a native colour input now
  sits alongside them for any hex value. Separately, the active-tab / custom
  colour accent was hard-coded to a 2px top cap — a new
  Settings → Grid → "Tab accent style" preference (`cap` / `rail` / `boxed`)
  switches it to a left rail or a raised-surface look instead, and a custom
  tab colour now follows whichever edge the chosen style uses instead of
  always drawing on top.

### Changed

- **Themed tooltips (UI/UX overhaul, phase 3).** Added a `SimpleTooltip`
  convenience wrapper over the themed Tooltip primitive and migrated the app
  chrome off native `title=""` so its tooltips match the app's theme instead of
  the OS default: the header buttons (theme toggle, preferences), every
  status-bar affordance (command palette, query-history, density and theme
  toggles, the connections switcher) and the workspace tabs (label, actions ⋮,
  close, new-query +). Menu/context triggers are wrapped at the trigger so the
  tooltip fires on hover while the menu still opens on click. The one case left
  on native `title=""` — deliberately — is a tooltip that lives _inside_ open
  menu content (the connection rows' reconnect/disconnect, the tab colour
  swatches): a Radix tooltip there fights the menu's own hover/portal handling,
  and a native OS tooltip doesn't.
- **Clearer connection status (UI/UX overhaul, phase 3).** A lost connection —
  arguably the most important operational signal — was a 6px red dot plus a
  cryptic red icon. Lost rows in the status-bar connection switcher now get a
  destructive row wash and an explicit labelled "Reconnect" button; the
  live/lost indicator dots are a touch larger, the row action buttons have a
  real hit area, and a failed connect surfaces a toast instead of a native
  `alert()`. Status-bar stats (row count, elapsed time, selection) promote their
  numbers to the foreground with tabular figures.
- **Accessible tab actions + active-tab weight (UI/UX overhaul, phase 3).** The
  workspace tabs' close (×) and actions (⋮) buttons were revealed on hover only,
  leaving them unreachable by keyboard; they now also appear on keyboard focus
  (focus-within / focus-visible). The active tab's label gains medium weight to
  match the brand top-cap + raised surface it already carries.
- **Distinctive dialog shell (UI/UX overhaul, phase 3).** Every dialog rode a
  flat `shadow-lg` with a fade-only entry and a bare low-opacity close glyph.
  `DialogContent` now scales in from centre (zoom, the correct motion for a
  centred modal), rides the shared elevation scale (`shadow-elevation-4`), and
  its close button is a properly padded control with a hover background instead
  of a hit-area-less 70%-opacity X.
- **Shared segmented control + console/structure cleanup (UI/UX overhaul,
  phase 2).** A new `Segmented` primitive (keyboard-navigable radiogroup styled
  as one pill strip with a raised active segment) replaces the hand-rolled
  variants: the feedback dialog's bug/feature toggle (two full buttons) and the
  structure editor's section tabs (plain buttons with no active-tab language).
  The console's log filter now uses the shared `Input` (small size) instead of
  a hand-rolled search box, and its kind checkboxes are tinted with `accent-brand`.
- **CellEditor flagship framing (UI/UX overhaul, phase 2).** The Monaco cell
  editor — the app's "star feature" — looked like a stock dialog. It now has a
  titled header rail: the column name, a `brand`-tinted content-type badge
  (JSON/XML/SQL/TEXT), and char/byte-count pills, with the panel/fullscreen
  controls grouped to the right. Ctrl/⌘+S and Ctrl/⌘+Enter save from inside the
  editor (bound via Monaco so they aren't swallowed) with the shortcut shown in
  the footer, the JSON-validity badge is now a compact chip with the parser
  message in its tooltip instead of dumped inline, and the brittle `mr-8`
  close-button-dodge hack is replaced by reserved header padding.
- **Command palette polish (UI/UX overhaul, phase 2).** The flagship
  keyboard-first surface gained the affordances it was missing: a persistent
  footer legend (↑↓ navigate · ↵ run · esc close), a trailing ↵ on the active
  row, a `brand` left-edge accent + brand-tinted icon on the active row, group
  counts on the section headers, and an iconified empty state. The highlighted
  row now scrolls into view during arrow-key navigation (it could previously
  scroll off-screen), and a failed connect surfaces a toast instead of a native
  `alert()`.
- **Unified table-browser chrome (UI/UX overhaul, phase 1).** A table tab used
  to stack two near-identical toolbars. The top bar's breadcrumb (schema ›
  table) and refresh now fold into the data grid's own toolbar so there's a
  single bar, and paging + row-zoom move to a footer status strip with tabular
  figures. The first load of a table shows a shimmer skeleton (with the
  breadcrumb) instead of a bare "loading…" line, and a refetch dims the stale
  rows behind a spinner rather than looking frozen. The delete-row confirmation
  button now uses the destructive (red) style, matching the drop-table dialog.
- **Data-grid readability polish (UI/UX overhaul, phase 1).** Column headers now
  show a persistent sort glyph that brightens on hover (it was a near-invisible
  30%-opacity icon), and the whole header cell gets a hover background so
  sortability is discoverable; the active-sort indicator is right-aligned and
  tinted with `brand`. Numeric readouts — the row count, pagination range and
  query elapsed time — use tabular figures so they stop shifting width as they
  change, the row/total counts are emphasised in the foreground, and the
  elapsed time turns amber then red only when a query is slow.
- **Tokenised data-semantic accents (`--pk` / `--fk` / `--numeric`).** The
  primary-key / foreign-key key icons and numeric cell values were hard-coded
  as `amber-400` / `sky-400` in the grid and schema tree, ignoring the active
  theme. They're now theme tokens (curated per built-in theme; darker on light
  themes so numerics stay legible on white) applied in DataGrid and
  SchemaExplorer. Kept out of the Appearance colour editor as niche system
  accents.
- **Design-system foundation (UI/UX overhaul, phase 0).** First pass of a
  larger interface redesign toward a modern, dense dev-tool look. No new
  features — this is groundwork the rest of the overhaul builds on:
  - Two new semantic theme tokens, `--success` and `--warning`, distinct from
    `brand` (the app's one "live / do this" accent) and `destructive` (errors).
    Every built-in theme sets its own curated values and both are editable in
    Settings → Appearance like any other colour. This replaces the hard-coded
    `emerald-*` / `amber-*` / `blue-500` / `red-500` literals that were
    scattered across ~12 components and ignored the active theme entirely — so
    custom themes now recolour connection-status, valid/invalid, warning and
    error affordances. `applyTheme` also clears any token a (pre-existing)
    custom theme doesn't define, letting the stylesheet default apply instead
    of leaving a stale inline value from the previously active theme.
  - Unified the "this connection is live" indicator on the `brand` token; it
    previously rendered emerald in the File menu but brand in the status-bar
    switcher for the exact same state.
  - Added an elevation scale (`shadow-elevation-1…4`, keyed off `--foreground`
    so it reads in both light and dark themes) and a tokenised micro-type scale
    (`text-2xs` / `text-3xs`, with a 10px legibility floor) to replace ad-hoc
    `text-[9px/10px/11px]` values.
  - Stronger, consistent keyboard focus ring (`ring-2` + offset) on buttons,
    inputs and selects, replacing the near-invisible 1px flush ring.
  - Form field labels now default to `text-foreground` instead of muted grey,
    giving every dialog real label/value hierarchy.
  - `Input` gained density variants (`inputSize` default/sm/xs) and a new shared
    `Textarea` primitive replaces the hand-rolled multiline fields in the
    feedback and save-query dialogs.
  - Defined a real UI sans-serif font stack (Inter first, falling back to the
    platform UI font) instead of relying on the bare system default.

### Fixed

- **Long table names no longer force horizontal scroll in the schema tree
  (#33).** The table-name label had `truncate` but, as a flex child with no
  `min-w-0`, never actually shrank below its content width (flex items
  default to `min-width: auto`) — so a long name pushed the row-count/size
  badge off and the tree scrolled horizontally instead of ellipsizing.
- **The tab's right-click menu now matches its ⋮ menu (#36).** The two were
  hand-maintained separately and had drifted: right-click was missing
  Split right/down, Float panel, and the colour swatches that the ⋮ menu
  already had. Both now show the same actions in the same order.

## [1.5.1] — 2026-07-07

### Added

- **Drop database from the multi-DB explorer (#19).** The database node's
  context menu gained a destructive "Drop database…" action (Postgres/MySQL
  only), so a database you created can also be removed — previously the node
  only offered "New query here" / "Security" and a created database was stuck.
  A new `validate_ident`-guarded `drop_database` backend command closes the
  synthetic per-database pool (awaiting `Pool::close`) before issuing `DROP
DATABASE`, so Postgres doesn't reject it for having live sessions; on success
  the UI tears down that database's tabs + schema slice and refreshes the tree.
- **Connection groups shown as folders in the File menu (#20).** The File menu
  listed every connection flat, so a profile's `group` had no visible effect
  there. Connections are now bucketed by group: ungrouped first, then one
  labelled folder per group (sorted) with its connections indented beneath.
- **Themed combobox for the Group field (#21).** The connection editor's Group
  field used a native `<datalist>` whose suggestion popup was drawn by the
  OS/webview and ignored the app theme. It's now a themed, still-creatable
  combobox (typing a new name still creates a new group) that substring-filters
  existing group names in an in-theme popover.
- **Tab colour coding (#24).** Open tabs can be colour-coded from the tab's ⋮
  menu (six preset swatches + clear); the colour shows as a 2px cap on the
  tab's top edge and persists per connection.
- **Refresh button in the structure editor (#25).** The table-structure tab
  gained a refresh button that re-reads the table's current definition from the
  server, so changes made elsewhere while the tab is open can be pulled in.
- **Scroll-to-top / scroll-to-bottom in the console (#29).** Two toolbar
  buttons jump the console log to its first or last entry.
- **Active connection marked in the status dropdown (#31).** The connection the
  workspace is focused on now gets a brand wash + "active" tag in the status-bar
  dropdown, distinct from the other merely-connected rows.

### Fixed

- **Connection errors no longer clip at the dialog edge.** A failed Test /
  Connect rendered its (often long) backend message on a single `truncate`d
  line in the connection dialog footer, so anything past the dialog width was
  cut off with an ellipsis and unreadable — most database driver errors are far
  wider than the footer. Error and save-error states now get a bounded,
  wrapping, vertically-scrollable box (destructive-tinted, with an alert icon)
  and a one-click copy button for the full message; the short states (testing /
  success / saved) stay on their single line.
- **Same table on two connections/databases no longer renders identical tabs
  (#22).** Tab labels only carried a connection prefix when more than one
  distinct connection had tabs open, and the prefix omitted the database, so
  the same table opened on two connections (or two same-named databases) showed
  as an indistinguishable bare name. Labels now include `connection · database`
  context and escalate to it whenever another open tab shares the bare title.
- **A CLI second-launch no longer spawns a third window (#23).** With "always
  open in a new window" set, launching again from the CLI while an instance was
  running produced three windows. The second-launch routing ran in every
  window, so the window spawned to satisfy the "new window" route re-drained the
  shared pending-intent buffer and routed it a second time. Routing is now
  gated to the main window only.
- **Empty tables show their columns and the insert affordance (#27).** A table
  with no rows rendered no column headers and no way to add the first row,
  because the result decoders derive columns from the first row. `fetch_table_data`
  now falls back to the catalog definition when a page comes back empty.
- **DDL apply failures are surfaced (#26).** A structure change the database
  rejects — e.g. a primary key exceeding MySQL's max key length — only showed a
  message in the small DDL-preview pane and read as a silent no-op. It now also
  raises a toast.
- **The port field can be cleared (#28).** Emptying a numeric port field snapped
  back to a stuck `0` that couldn't be backspaced away. Falsy `0` now renders as
  an empty field, restoring normal clear/retype (all four port inputs).
- **No text highlighting on Shift+Click row selection (#30).** Range-selecting
  rows also dragged a native text selection across their contents; the grid is
  now `select-none`.
- **Connection dropdown consistency (#31).** The File-menu dropdown now shows
  connection groups (see the grouping change above) and the status-bar dropdown
  marks the active connection, resolving both halves of the report.

## [1.5.0] — 2026-07-04

### Added

- **Create database.** Both the multi-DB explorer toolbar and the
  single-database root header gained a "+" button (Postgres/MySQL only —
  server-level DDL, hidden for SQLite/MongoDB) that opens a name dialog and
  issues `CREATE DATABASE` via a new `create_database` backend command,
  validated through the same `validate_ident` allowlist the structure
  editor uses. The multi-DB toolbar refreshes its database list on success;
  a single-DB connection has no such list to show the change, so it
  confirms with a message instead (a profile scoped to one database is at
  least as common as multi-DB browsing — there's no reason it should be the
  one mode that can't create a sibling database on the same server).
- **Resizable data-grid columns.** `DataGrid.tsx` now wires up TanStack
  Table's column-resizing API (drag handles on column borders,
  `columnResizeMode: "onEnd"` so a drag doesn't spam re-renders). Widths are
  persisted per browsed table (`prefs.json`'s new `grid.columnWidths`,
  keyed by `"<schema>.<table>"` then column name) — ad-hoc query result
  grids resize in-session only, matching how they don't have a stable table
  identity to key against.

- **Connection grouping.** `ConnectionProfile` gained a free-text `group`
  field (single group per connection, no separate group registry — grouped
  by simple string equality), editable from a new "Group" field in the
  connection dialog (with a datalist of existing group names as a
  duplicate-avoidance nudge). The status-bar connections dropdown
  (`StatusConnections.tsx`) — the app's actual live connection
  switcher — now buckets both the Active and Available sections into
  collapsible per-group headers, with ungrouped connections staying flat at
  the top exactly as before. Collapse state persists per group name in
  `prefs.json` (`ui.collapsedConnectionGroups`). New `bucketByGroup` helper
  in `src/lib/utils.ts`.

### Fixed

- **Connecting the same profile from a second window tore down the first
  window's live pool.** `ActiveConnections::insert` unconditionally replaces
  whatever pool is already registered for an id — correct for reconnecting
  a dead pool, wrong for a second window's `connect` call racing an
  already-active profile, which silently dropped the first window's pool
  (and any SSH tunnel) out from under it. `connect` now checks
  `ActiveConnections::contains` first and no-ops (reusing the existing
  pool) instead of falling through to the replace path.
- **No window learned about another window's connections, profile edits, or
  preference changes.** Every Tauri window shares one backend `AppState`,
  but each window's frontend held a private snapshot of `active`/`profiles`/
  `prefs` taken once at boot with no bridge back out — worse than staleness
  for preferences specifically, since every save sends the _entire_ blob
  (not a diff): two windows changing different settings would silently lose
  whichever saved first the moment the other's debounced write landed.
  `connect`/`disconnect`/`save_profile`/`delete_profile`/`import_profiles`/
  `update_preferences` now broadcast `connection-opened`/`-closed`/
  `profiles-changed`/`prefs-changed` events; new frontend bridges
  (`connection-sync-bridge.ts`, `prefs-sync-bridge.ts`) apply them to every
  window's stores — `markConnected`/`markDisconnected` in
  `stores/connections.ts` (factored out of `connect()`/`disconnect()` so
  the sync path and the local path share the exact same cleanup, including
  the multi-DB synthetic-child tab/schema sweep) and `applyExternal` in
  `stores/preferences.ts` (adopts the broadcasted snapshot without
  re-triggering a save, so it can't loop or re-race).
- **MySQL `insert_row`/`update_cell` could bind a `BIT` column as plain text
  when the frontend's schema-cache metadata hadn't loaded yet.** Both
  commands decide whether to wrap a MySQL `BIT` column's placeholder in
  `CAST(? AS UNSIGNED)` based on a `column_type` hint the frontend sends
  alongside the value; when that hint is `None` (schema cache empty/stale
  for the target table), the value was bound as a plain string, which
  MySQL rejects with `1406 (22001): Data too long for column` for anything
  wider than one character (e.g. `"true"`). Both commands now fall back to
  a catalog lookup (`list_columns_inner`, the same helper `fetch_fk_options`
  already uses) when the hint is missing, so a `BIT` column is detected
  correctly either way. `insert_row` only pays for the extra round-trip
  when at least one value actually lacks a type hint.
- **Console/connection-lifecycle log entries leaked across windows.** Every
  Tauri window (the main window, or any secondary "New window") mounted the
  same frontend and independently subscribed to the same backend log event,
  which was broadcast process-wide (`AppHandle::emit`) rather than targeted —
  so a query run in one window showed up in every other open window's
  Console panel too, making a secondary window look like a pointless copy
  of the main one instead of an independent instance. `log_bus::emit` now
  takes the originating window's label and delivers only to it
  (`AppHandle::emit_to`); every command that produces a SQL or
  connection-lifecycle log entry (`execute_query`, `execute_batch`,
  `fetch_table_data`, `update_cell`, `delete_rows`, `insert_row`, `connect`,
  `disconnect`, `test_connection`, `open_database_view`) now takes a
  `tauri::Window` parameter (auto-injected by Tauri from the invoking
  webview — no frontend change needed) to supply it. The keepalive
  background task's own diagnostic log entry has no single originating
  window (it reports on a connection every window may be browsing), so it
  keeps broadcasting via a new `log_bus::broadcast`; the separate
  `connection-lost` event it emits for the reconnect UX was already correct
  as a broadcast and is unchanged.

## [1.4.0] — 2026-07-02

### Added

- **Server-side users/permissions ("Security" panel).** A new `Security`
  action next to the schema explorer's refresh button (and, per database, in
  the multi-DB explorer's context menu) opens a tab listing the users/roles
  the current connection can see, with lazy-loaded privileges on row expand.
  Implemented for every driver rather than a subset: **PostgreSQL**
  (`pg_roles` + `pg_auth_members` for role membership, table grants via
  `information_schema.role_table_grants`), **MySQL** (`mysql.user` +
  `mysql.role_edges` for MySQL 8 roles, privileges parsed out of
  `SHOW GRANTS FOR '<user>'@'<host>'` since MySQL has no privilege catalog
  view equivalent to Postgres'), **MongoDB** (`usersInfo` per the resolved
  database, privileges via `usersInfo` with `showPrivileges: true`), and
  **SQLite**, which has no user/permission concept at all and now renders an
  explicit "this driver has no server-side user model" empty state instead
  of silently omitting the feature. A MySQL account without `SELECT` on
  `mysql.user` degrades to reporting just itself (`CURRENT_USER()`) instead
  of failing the whole panel. New backend commands `list_users` /
  `list_privileges` in `src-tauri/src/commands/schema.rs` (dispatched to
  `src-tauri/src/db/mongo/schema.rs` for MongoDB); new `UserInfo` /
  `PrivilegeInfo` DTOs mirrored in `src/types.ts`; new frontend
  `SecurityTab.tsx` (TanStack Table) and `security` tab kind.
- **Connection keepalive + lost-connection reconnect.** HuginnDB previously
  did nothing proactive to keep a connection alive — no idle timeout, no
  heartbeat — relying entirely on `sqlx`'s default "validate on next use"
  behaviour, which doesn't help an idle pool between user actions or a
  dropped SSH tunnel. Every top-level connection now gets a background ping
  every 3 minutes; a failed ping flags the connection as lost, which turns
  its status dot red in both the connection list and the status-bar
  connections dropdown and swaps the connect/disconnect button for a
  one-click "reconnect" — no more discovering a dead connection mid-query
  with only a cryptic driver error. Reconnecting reuses the same connection
  id and keeps open tabs and schema-tree state intact rather than closing
  everything and starting over. Scoped to top-level profile connections
  only; the synthetic per-database pools used by multi-DB browsing share
  their parent's liveness and don't get a separate heartbeat. New backend
  module `src-tauri/src/keepalive.rs`; new frontend
  `stores/connectionHealth.ts` + `lib/connection-health-bridge.ts`.
- **F5 / Ctrl+R (Cmd+R on macOS) now refresh in-app instead of reloading the
  WebView like a browser tab.** With a table tab active, it re-runs that
  tab's own query (same as clicking its reload button, respecting the
  current filters/sort/page); otherwise it refreshes the schema tree
  (database + table list) for the selected connection — matching the
  explorer's own refresh button in both single-DB and multi-DB mode. New
  `src/lib/tableRefresh.ts` registry (same "populate on mount, clear on
  unmount" shape as the Monaco SQL provider registry) lets the global
  key handler in `App.tsx` reach the active table tab's reload function
  without threading a callback through the dockview panel tree.

### Changed

- **Workspaces replaced by native windows.** Workspaces were only ever a
  stand-in for real per-window instances, and the "new workspace vs current"
  dialog shown on a second `huginndb …` launch never worked correctly. The
  workspace switcher is gone; **Window → New window** opens a real, blank OS
  window instead. Secondary windows are intentionally ephemeral — nothing
  about their tabs or layout survives an app restart, only the main
  window's does. The on-disk `tab_state.json` moves to v3 (a flat
  `connections` map); on upgrade, a v2 blob keeps only the previously
  **active** workspace's tabs and discards every other workspace — there is
  no merge. The second-launch dialog still asks "this window or a new one?"
  by default, but now offers a "don't ask again" toggle that remembers the
  choice (`Preferences → cliConnectDefault`).
- **Top bar menus split from 2 to 4.** File and View had accumulated
  unrelated actions as the app grew. File now holds only connection
  management (new/manage/import/export, the connection list, disconnect
  all); a new **Window** menu takes New window and Reset window layout; a
  new **Help** menu takes Report/suggest and About (previously File-only
  and gear-icon-only, respectively). View is unchanged (panel visibility +
  schema-tree metric).

### Fixed

- **A new window created via "Window → New window" rendered blank and
  Windows flagged it as "Not Responding".** `WebviewWindowBuilder::build()`
  deadlocks on Windows when called from a synchronous Tauri command — a
  documented WebView2 issue. `open_new_window` is now an `async fn`, which
  Tauri docs call out as the fix.
- **A CLI ad-hoc connection (`--host …`) without `--password` never
  actually connected**, even when chosen via the second-launch dialog's
  "this window" option — it silently created a disconnected profile and
  only logged a hint to the Console. The connect is now always attempted
  (SQLite has no password concept at all, and some servers allow
  passwordless/trust auth); a genuine auth failure still surfaces the same
  way a saved-profile connect failure does.

## [1.3.0] — 2026-07-01

### Added

- **"I don't have a GitHub account" fallback in the issue reporter.** Both
  existing paths (API creation with a stored PAT, or the pre-filled
  `issues/new` browser page without one) still land on GitHub, which is a
  dead end for a user with no account — the browser page just shows a login
  wall. A new link in the dialog's footer builds a `mailto:` URL instead
  (same title/kind-prefixed subject and body, diagnostics block included when
  toggled on) and opens it via the `opener` plugin, handing delivery to the
  user's own default mail app — HuginnDB never touches SMTP or holds a
  mail-sending credential. Percent-encoding is hand-rolled (RFC 3986
  unreserved set) rather than reusing `url`'s `query_pairs_mut`, which is
  `application/x-www-form-urlencoded` and would turn spaces into literal `+`
  characters in the body — technically invalid in a `mailto:` query and
  rendered as-is by several mail clients. The recipient is the project's
  `contact@shion.es` address, kept separate from the mailto path's GitHub
  siblings so a stray report can't be mistaken for a security disclosure.
  Requires widening the `opener:allow-open-url` capability, previously scoped
  to `github.com` only, to also allow `mailto:*`.

- **"Go to referenced row" on foreign-key cells (IDE-style).** In the data
  browser, **Ctrl/Cmd+click** on a cell whose column is a single-column foreign
  key now jumps straight to the referenced master record — opening (or focusing)
  the parent table pre-filtered to that value, the way "go to definition" works
  in an editor. The same action is available from the cell's right-click menu
  ("Go to referenced row"), and FK-navigable cells gain a subtle hover
  underline. Reuses the FK metadata already returned by `list_columns`
  (`referenced_schema` / `referenced_table` / `referenced_column`) — no new
  backend query. The target table receives the filter through a new transient
  `initialFilters` on the tab; re-navigating into an already-open table
  re-applies it instead of silently doing nothing.
- **"New query here" on a database (multi-DB explorer).** Right-clicking a
  database node in the multi-database explorer now offers _New query here_,
  opening a query tab already scoped to that database. It runs against the same
  synthetic per-database connection the explorer uses, so the query targets the
  database you clicked without first having to expand it or switch the active
  scope.

### Fixed

- **The in-app issue reporter now actually opens the browser.** Filing a report
  (or following the "view issue" link) relied on `window.open`, which is a no-op
  inside the Tauri WebView — clicking did nothing. URL opening now goes through
  the `tauri-plugin-opener` plugin and lands in the OS default browser. The new
  capability is scoped to `github.com`, the only host the reporter ever links
  to. Adds the `tauri-plugin-opener` dependency.
- **Hand-typed `INSERT`/`UPDATE` with `BIT`/integer values no longer errors on
  MySQL.** Ad-hoc statements from the SQL editor were sent over the prepared
  (binary) protocol, which rejects or mishandles a family of statements a CLI
  client runs without complaint — the recurring `BIT` / integer-literal errors.
  The editor binds no parameters, so there is nothing to prepare: non-`SELECT`
  statements now run through the **unprepared** simple-query protocol
  (`sqlx::raw_sql`) in both the single-statement and batch paths, so what you
  type is parsed exactly as the server's own client would. `SELECT` decoding is
  unchanged.

## [1.2.0] — 2026-06-18

### Added

- **Single-window consolidation (single instance).** Launching `huginndb` again
  while a window is already open no longer spawns a second window. The running
  window is focused, and — if the new launch carries a connection
  (`--connect-profile`, `--host …`, `--uri …`) — a dialog asks whether to open
  it in a **new workspace** or the **current** one. This makes the workspace the
  real top-level container: keep, say, a MySQL "config" connection and a MongoDB
  "data" connection side by side in one window instead of two detached IDE-like
  instances. A relaunch with no connection flags simply brings the window to the
  front. Implemented with `tauri-plugin-single-instance`; the second launch's
  argv is parsed by the same code path as cold start and forwarded over a new
  `huginndb://cli-connect` event (buffered backend-side to survive a launch that
  races the window's boot).
- **In-app issue reporter.** A new _Report / suggest_ entry (File menu, and a
  "Report this error" action on failed Console entries) opens a dialog to file
  a **bug** or a **feature request** straight to the GitHub tracker. With a
  GitHub Personal Access Token configured (stored in the OS keychain, never on
  disk) the issue is created directly via the REST API and linked back; without
  one, a pre-filled `issues/new` page opens in the browser for manual
  submission. Reports can optionally bundle diagnostics (app version, OS/arch),
  and the "Report this error" path pre-fills the driver, statement, and error
  text. Adds a `reqwest` (rustls) dependency for the API path.
- **Multi-column sort in the data grid.** A plain click on a column header
  sorts by it (cycling ASC → DESC → unsorted); **Ctrl/Cmd+click** adds the
  column as an additional, lower-precedence sort level (cycling
  ASC → DESC → removed in place). Headers now show a direction arrow (↑/↓)
  instead of only highlighting, plus a small level number when more than one
  column participates, so the active ordering is readable at a glance rather
  than only inferable from the console. The `fetch_table_data` command now
  takes an ordered `order` list (replacing the single `orderBy`/`orderDesc`
  pair) and builds `ORDER BY c1 …, c2 …` across all four drivers (the MongoDB
  path uses a multi-key sort document).
- **Primary/foreign-key icons on data columns.** The data-grid column headers
  now show a key icon — amber for a primary-key column, sky-blue for a
  single-column foreign key — and the schema explorer gains the foreign-key
  key next to the existing primary-key one. Mirrors HeidiSQL's at-a-glance key
  indicators; uses metadata already returned by `list_columns`, no extra
  queries.

### Performance

- **Skip the redundant `COUNT(*)` when only sorting or paging.** The data
  browser previously re-ran `SELECT COUNT(*)` on every fetch, including pure
  sort/offset/page changes where the total can't have changed. The frontend
  now caches the total and recomputes it only when the filter/search predicate
  changes (new `with_count` flag on `fetch_table_data`), removing one
  round trip per sort/page interaction — most noticeable on large tables. The
  MongoDB browse path skips `count_documents` the same way. (Sorting on a
  non-indexed column is still a server-side full sort; that's governed by the
  table's indexes, not the client.)

### Changed

- **Simpler "Drop table" confirmation.** Dropping a table no longer requires
  typing the table name to confirm — it now shows a plain destructive
  confirmation dialog (with an irreversibility warning) and a Cancel / Drop
  choice, matching what users expect from other database managers. The action
  is still gated behind an explicit confirmation; only the type-the-name
  friction was removed.

## [1.1.1] — 2026-06-15

### Added

- **MongoDB connection form (field-driven).** The MongoDB connection dialog is
  now form-primary, like Mongo Compass: discrete fields (host, port, database,
  username, password, **auth source**) build the `mongodb://` connection string
  live, shown read-only below them. A new **Edit connection string** toggle
  reveals the raw URI for hand editing — with an amber warning that manual edits
  can introduce errors — for cases the form doesn't cover (Atlas
  `mongodb+srv://`, replica sets, extra URI options). The password is never
  embedded in the stored string: it continues through the OS keychain. Editing a
  saved profile re-populates the form when its URI is representable, and opens in
  raw-edit mode otherwise.
- **`authSource` for MongoDB.** A dedicated _Auth source_ field (e.g. `admin`)
  is appended to the connection string as `?authSource=…`, and a new CLI
  `--auth-source` flag covers the URI-less ad-hoc path
  (`--host … --auth-source admin`). Previously the only way to set it was to
  hand-write the whole URI, and the discrete-field path omitted it entirely —
  so URI-less MongoDB logins that needed a non-default auth database failed.
- **Multi-table filter in the schema explorer (HeidiSQL-style).** The table
  filter now accepts several `;`-separated patterns and matches a table when it
  contains **any** of them, so `users; orders` surfaces both at once. Works in
  both single- and multi-database explorers.

### Fixed

- **The Console detail pane can be closed without clearing the console.**
  Clicking a log entry opened its detail view with no way back to the full list
  short of emptying the console; a **close** button (and the `Esc` key) now
  dismiss the detail and return to the entry list.

## [1.1.0]

### Added

- **MongoDB driver (MVP).** HuginnDB now connects to MongoDB alongside the SQL
  engines. Connect with a connection string (`mongodb://…` or Atlas
  `mongodb+srv://…`, the primary input — it covers replica sets, `authSource`
  and URI options), browse databases → collections in the explorer, and inspect
  documents in the data grid (top-level fields become columns, `_id` first;
  nested documents/arrays render as JSON and expand in the cell preview).
  - **`mongosh`-style query editor.** Run `db.coll.find({…})`,
    `.aggregate([…])`, `.countDocuments(…)`, `.distinct(…)`, and the write
    methods (`insertOne`/`insertMany`, `updateOne`/`updateMany`, `replaceOne`,
    `deleteOne`/`deleteMany`), with chained `.sort()/.limit()/.skip()/.projection()`
    on `find`. Relaxed JSON (unquoted keys, single quotes) and the common BSON
    constructors (`ObjectId(...)`, `ISODate(...)`, `NumberLong/Int/Decimal(...)`)
    are supported.
  - **Edit by `_id`.** Inline cell edits, row inserts and deletes map to
    `updateOne`/`insertOne`/`deleteMany` keyed on `_id`. The field's inferred
    BSON type drives value coercion so a `Date`/`Long`/`Int` field is not
    silently degraded to a string.
  - **Read-only structure.** The structure view shows a collection's inferred
    fields and real indexes; collection drop is supported from the explorer.
    Index/validator editing, transactions, and profile transfer for MongoDB are
    deferred — see `docs/MONGODB_ROADMAP.md`.
  - **SSH tunnelling** is available for single-host `mongodb://` connections;
    it is disabled for `mongodb+srv://` (an SRV record resolves to several
    hosts, which the single-port tunnel can't represent).
  - **CLI:** `--driver mongodb` works with the discrete `--host`/`--port`
    flags, and a new `--uri` / `--connection-string` flag accepts a full
    `mongodb://` or `mongodb+srv://` URI (the only way to reach Atlas from the
    CLI). A connection string implies the MongoDB driver when `--driver` is
    omitted, and MongoDB is now offered in the ad-hoc driver picker.
- **Bulk-close tabs from the tab menu.** Right-clicking a workspace tab (or the
  tab's `⋮` menu) now offers **Close other tabs** and **Close all tabs** in
  addition to **Close tab**, so a workspace full of open tables/queries can be
  cleared in one action instead of closing each tab individually.

### Fixed

- **Filtering the schema explorer no longer crashes on connections without table
  stats.** `list_tables` serialized absent row-count / size statistics as JSON
  `null`; the explorer's metric badge guarded only against `undefined`, so a
  `null` reached `formatBytes` and threw _"Cannot read properties of null
  (reading 'toFixed')"_ — taking down the whole panel. This bit CLI/ad-hoc
  connections and SQLite builds without `dbstat`, and surfaced on filter because
  the filter force-expands every section (rendering badges that were previously
  collapsed). The backend now omits absent stats (matching the `?: number`
  frontend contract) and the badge guards `!= null`; `formatBytes`/`formatCount`
  additionally bail on non-finite input.
- **Opening or closing the side cell-editor no longer resets the Schema /
  Workspace split.** The side-editor docks as a sibling in the
  `[Schema | Workspace | Cell]` row, and dockview redistributes freed/taken
  space proportionally across _all_ siblings when a child is added or removed —
  silently resizing the Schema panel each time. The Schema width is now
  remembered while the side-editor is absent and re-asserted on every
  open/close, so only the Workspace panel absorbs the change.
- **Duplicating a MySQL row with a `BIT` column then saving could fail with
  "Data too long for column".** The 0/1 control showed the normalized value but
  left the draft cell holding the raw duplicated value; if that value wasn't
  already exactly `"0"`/`"1"` (e.g. a duplicated `"true"`, or a legacy `BIT(1)`
  cell carrying a wider/garbage integer), the raw value was what got committed,
  and `CAST(? AS UNSIGNED)` into `BIT(1)` then overflowed. The control now syncs
  the committed cell to the displayed `0`/`1` on mount.

## [1.0.10] — 2026-06-11

### Added

- **Run a whole buffer of statements at once.** Pressing `Ctrl+Enter` (or the
  new "Run all (N)" button) on an editor holding several `;`-delimited
  statements — e.g. a batch of INSERTs copied from the grid — now runs them in
  order on a single connection and shows a per-statement summary, with the last
  SELECT's rows in the grid. Previously the whole buffer was sent as one
  prepared statement, which the driver rejected ("cannot insert multiple
  commands into a prepared statement"). Running them on one connection also
  means an explicit `BEGIN`/`COMMIT` (or MySQL `USE`) now carries across the
  batch. The per-statement "▶ Run" CodeLens still runs a single statement.
- **Database selector in the query editor.** On a multi-database server
  (Postgres / MySQL) the query tab now has a database dropdown: pick a database
  and the query runs against it — and the autocomplete switches to its tables —
  without typing `USE`/a schema prefix into the SQL. Backed by the existing
  per-database child pools. SQLite (single file) shows no selector.
- **Theme and editor previews in Preferences.** Appearance shows a small mock of
  the app chrome plus colour swatches painted with the selected theme; Editor
  shows a sample SQL snippet rendered with the chosen font, size, wrap and
  Monaco theme colours.
- **Fullscreen toggle in the side cell editor**, matching the modal editor
  (`F11` / `Esc`, or the header button).
- **Dedicated 0/1 control for `BIT` columns** in the insert draft row and inline
  cell editing (MySQL). It emits the numeric value the column expects and labels
  the options per the grid's BIT-display preference, instead of a text field
  that looked like it wanted a boolean.

### Changed

- **Connections opened from the CLI are now temporary.** An ad-hoc connection
  launched with `--host …` is kept in memory for the session (so the explorer
  and tabs work normally, marked "temp") but is no longer written to
  `profiles.json`, so it doesn't pile up across launches. Profiles created in
  the app still persist as before.
- **Driver badge tiles are theme-aware** — the brand logos keep their colours
  but the tile/ring now track the active theme instead of a hardcoded white
  square that clashed with dark themes.

### Fixed

- **A large `LONGTEXT` (e.g. a big JSON document) in MySQL rendered as a hex
  dump.** When the server flags a text column as binary (charset/collation
  dependent), sqlx reports it as `LONGBLOB` and `try_get::<String>` rejected it
  on a type-compatibility check _before_ looking at the bytes, so the value fell
  through to hex regardless of content. We now read the raw bytes and validate
  UTF-8 ourselves, so valid-UTF-8 text decodes as text.

## [1.0.9] — 2026-06-09

### Fixed

- **Opening a specific database failed with "no stored password for keychain
  account" when the password came from the CLI.** Expanding a database in the
  tree spins up a child pool (`open_database_view`) that re-resolved the
  credentials from the OS keychain — but a password passed via `--password`
  (or the connect dialog) lives only in memory and was never stored there. The
  backend now keeps a session-only, in-memory cache of the secret used at
  connect time (keyed by profile, cleared on disconnect); child pools reuse it
  and only fall back to the keychain when nothing was cached.

## [1.0.8] — 2026-06-09

### Added

- **Configurable default database driver** (Settings → General). Used when a
  connection is created without an explicit driver: a CLI launch without
  `--driver`, and the initial driver of the "New connection" form. It defaults
  to **"Ask each time"** — so a CLI ad-hoc launch (`--host …`) with no `--driver`
  and no configured default now pops a driver picker (and nudges you to set a
  default) instead of silently assuming PostgreSQL and mismatching a MySQL
  server.

### Changed

- **`--driver` now accepts aliases and is case-insensitive** (`MySQL`, `MYSQL`,
  `mariadb` → mysql; `postgresql`, `pg`, `psql` → postgres; `sqlite3` → sqlite).
  An unrecognized value no longer silently falls back to PostgreSQL — it routes
  to the driver picker.
- **Connection failures caused by a mismatched driver now explain themselves.**
  When a wire-protocol error indicates the wrong backend (e.g. the Postgres
  driver reading a MySQL handshake — "Postgres protocol error … unknown
  transaction status"), the error message now suggests switching the driver,
  in the Console and in the connect dialogs.

## [1.0.7] — 2026-06-08

### Fixed

- **Connections with SSL off failed during the TLS negotiation** ("unexpected
  response from SSLRequest"). With the SSL box unchecked the connection URL
  carried no `sslmode`, so sqlx fell back to its `prefer`/`PREFERRED` default —
  which still sends a Postgres `SSLRequest` (or negotiates MySQL TLS) and chokes
  against servers or poolers that don't speak it. The SSL toggle is now
  explicit: off → `sslmode=disable` / `ssl-mode=DISABLED` (straight to a
  plaintext startup, no negotiation), on → `require` / `REQUIRED`. A server that
  genuinely requires TLS now fails with a clear "enable SSL" error instead of a
  cryptic handshake byte.

## [1.0.6] — 2026-06-08

### Fixed

- **CLI `--flag=value` syntax was ignored.** The startup-arg parser only
  accepted the space-separated form (`--password secret`); the equals form
  (`--password=secret`) didn't match the flag and the value was silently
  dropped — so an ad-hoc launch like
  `huginndb.exe --host … --password=…` created the profile but reported "no
  --password given". The parser now accepts both forms for every flag
  (splitting on the first `=` so values containing `=` survive), with unit
  tests covering both spellings.

## [1.0.5] — 2026-06-08

### Changed

- **The connection dialog is now a master/detail manager** (same layout as the
  preferences dialog): a left rail lists every saved connection with a live
  "connected" dot and a "New connection" entry, and the right pane edits the
  selected profile via the General / SSH-tunnel tabs. The footer carries Test,
  Connect (save + open the pool), Delete (honoring `confirmDestructive`) and
  Save. Opening from the sidebar's `+`/edit still works; connecting from the
  manager focuses the connection in the main view. Import/export profiles live
  in the manager header, and File → "Manage connections" now opens this manager
  (focused on the current connection) instead of the old list-wrapper modal,
  which has been removed.

### Added

- **Official database logos replace the driver initials.** Connection lists,
  the file menu, the status-bar dropdown and the connection manager now show the
  PostgreSQL / MySQL / SQLite brand marks (bundled locally, no CDN) on a light
  tile so the darker logos stay legible on both themes.
- **The app logo now tops the empty-workspace welcome screen**, above the
  "huginndb — select or create a connection" hint.
- **The active connection is now visible at a glance.** The status-bar
  connections control shows the current connection's name and logo (instead of a
  bare count), and both that dropdown and the File menu mark the connection in
  focus with a check.
- **Cell preview panel can be turned off.** A new `grid.cellPreview` preference
  (Settings → Data grid) controls whether the floating value-preview panel
  appears when a cell is selected. With it off, single-click stays pure
  navigation; the heavyweight editor remains reachable via double-click and the
  context menu. Defaults to on (the historical behaviour).
- **`grid.truncateLongTextAt` is now exposed in Settings** and actually applied:
  the grid caps a cell's rendered text at the configured number of characters
  (0 disables) so a multi-MB value can't bloat the DOM. The full value is still
  available in the preview/editor.

### Fixed

- **Several preferences were silent no-ops.** Audited every toggle and wired up
  the ones that weren't being honored:
  - `grid.nullDisplay` — the configured NULL string now renders in both the data
    grid and the cell-preview panel (previously hard-coded `NULL`).
  - `grid.zebraStripes` — alternating row backgrounds are applied (was ignored).
  - `grid.stickyHeader` — the column header only pins when enabled (was always
    sticky).
  - `grid.defaultPageSize` — new table tabs open at the configured page size
    (was hard-coded to 100); the page-size dropdown includes custom values.
  - `ui.queryHistoryLimit` — the query-history ring buffer honors the configured
    size (was hard-coded to 50).
  - `ui.confirmDestructive` — turning it off now actually skips the delete
    confirmations (delete connection, delete saved query, delete rows); the
    type-the-name `DROP TABLE` guard intentionally stays regardless.
- **Ctrl+S in the docked side editor didn't clear the unsaved-changes guard.**
  When a cell was selected with the side panel open, the floating cell-preview
  panel was the one catching Ctrl+S and persisting _its_ stale (pre-edit) value,
  so the side panel's edits weren't saved and its dirty baseline never reset —
  moving to another cell then popped the discard-changes dialog. The side panel
  now owns Ctrl+S (capture phase, taking precedence over the preview): it saves
  its own buffer in place, resets the baseline, and keeps the panel open so you
  can move on without the prompt.
- **The Console detail editor ignored the editor preferences.** It now follows
  the configured Monaco theme, font family and font size instead of the app
  light/dark mode and a fixed font.
- **CLI auto-connect did nothing for ad-hoc launches and failed silently.** The
  startup-arg handler was gated on having at least one saved profile, so
  `--host/--port/--database/--driver/--user/--password` launches were skipped
  entirely on a profile-less machine; it also swallowed every error, so a
  mistyped profile name or a failed connect produced no feedback. The handler
  now runs once on boot regardless of the profile list, awaits a profile
  refresh before matching `--connect-profile` by name/id, and reports failures
  (profile not found, connect error, ad-hoc setup) in the Console panel. The
  backend additionally echoes the parsed flags to stderr on launch (password
  redacted) so a terminal launch can confirm the args arrived.
- **SSH tunnel didn't fall back when the pinned local port was held with
  exclusive access.** The bind-collision fallback only recognised `AddrInUse`;
  on Windows a port held by another tunnel/socket opened for exclusive use — or
  inside a reserved range (Hyper-V/WSL `netsh` reservations) — surfaces as
  `WSAEACCES` (`PermissionDenied`), which slipped through and broke the
  connection. The fallback now also covers `PermissionDenied` and
  `AddrNotAvailable`, retrying on an OS-assigned port. The reassignment is
  logged to the Console (not just stderr) so it isn't invisible.

## [1.0.4] — 2026-06-06

### Added

- **CLI `--password`/`--pass` flag and `--user` alias.** The password can now be
  supplied on the command line for both `--connect-profile` (overriding the
  stored keychain secret) and ad-hoc launches; when present the app
  auto-connects without the password dialog. The password is used **in memory
  only** — it is handed straight to `connect` and never written to the OS
  keychain. `--user` is accepted as an alias for `--username` to match the
  spelling used by `psql`/`mysql`.

### Fixed

- **Main panel titles stayed in English under a Spanish UI.** The outer dockview
  panels (Schema, Saved, Workspace, Console, Cell) had hard-coded English
  titles, baked into the persisted layout, so they never followed the selected
  language. Titles are now sourced from i18n, re-applied after a layout restore,
  and updated live when the language changes. The View → Panels checkboxes use
  the same translated labels. Inner workspace tab fallbacks (the `Query`/`Table`
  default labels and the `(structure)` suffix on structure-editor tabs) are now
  localized too.

- **MySQL `LONGTEXT`/`TEXT` rendered as a hex blob.** sqlx names a column
  `LONGBLOB`/`BLOB` (vs `LONGTEXT`/`TEXT`) from the protocol-level `BINARY`
  column flag, which the server sometimes sets on real text columns depending
  on charset/collation — so a `LONGTEXT` field could surface as a hex dump
  (HeidiSQL showed it as text). The decoder now tries a UTF-8 `String` decode
  first and only falls back to hex for genuinely non-UTF-8 bytes.

- **SSH tunnel broke when the configured local port was already in use.** If
  another process (e.g. a second tunnel the user opened by hand) held the
  pinned `local_port`, the bind failed with `AddrInUse` and the connection
  errored out. The tunnel now falls back to an OS-assigned ephemeral port and
  keeps working; the pool follows the actually-bound port and the saved profile
  is left untouched.

- **SSH tunnel form fields overflowed the dialog.** When reconfiguring an
  existing tunnel, long values (notably the private-key path) pushed inputs and
  the "Browse" button past the dialog edge. Added `min-w-0`/`flex-1`/`shrink-0`
  constraints so fields shrink within the dialog instead of overflowing.

- **MySQL `BIT` column write — `insert_row` path.** `RowValue` now carries an
  optional `column_type` field. When the frontend builds the draft-row INSERT
  payload it populates `columnType` from `result.columns`, and the backend
  builds `CAST(? AS UNSIGNED)` placeholders for every MySQL `BIT` column
  instead of plain `?`. Previously, binding a string like `"1"` to a `BIT`
  column stored the ASCII byte `0x31` (49) rather than the integer 1 — for
  wide `BIT(n)` columns this silently wrote the wrong value every time.

- **MySQL `BIT` column write — `update_cell` path.** Added
  `normalize_bit_value` preprocessing so that the string handed to
  `CAST(? AS UNSIGNED)` is always a digit string. Without this, if the cell
  editor produced `"true"` or `"false"` (e.g. after the user typed those words
  in the Monaco editor), MySQL would evaluate `CAST('true' AS UNSIGNED)` as 0
  regardless of the intended bit value.

## [1.0.3] — 2026-06-03

### Added

- **Command palette hint in the status bar.** A small `Ctrl+K` chip now sits
  in the bottom-right status bar. Clicking it opens the command palette
  directly; hovering shows the full tooltip ("Command palette (Ctrl+K)"). The
  label uses a dynamic import so it never blocks the status bar render.

- **Command palette (`Ctrl`/`Cmd`+K).** A keyboard-first launcher for the
  actions otherwise buried in menus: switch or connect a database, open a table
  from the active connection's schema, start a query, switch theme or language,
  and open Preferences. Built on the bundled Radix dialog plus a filtered list —
  no new dependency. Because Monaco swallows `Ctrl`+K inside the editor, the
  query editor registers its own editor-scoped command so the palette opens
  regardless of focus (gotcha #9).
- **Active-connections dropdown in the status bar.** The comma-joined list of
  open connections is now a dropdown: live pools at the top (click to jump to
  that workspace, or disconnect inline), saved-but-idle profiles below for
  quick-connect. Connect / disconnect mirror the File menu flow exactly.
- **Richer status bar.** Adds a live multi-row **selection count**, a
  **read-only** marker for query-result tabs, a clickable **query-history**
  popover (open a recent query in a fresh tab, or copy it when its connection is
  offline), and quick **row-density** and **light/dark** toggles.
- **"What's new" patch notes in Preferences → About.** A per-version reader
  sourced from the bundled `CHANGELOG.md`, defaulting to the installed version.
  When the UI language is Spanish it reads a parallel `CHANGELOG.es.md`, falling
  back to the English body for any version not yet translated.
- **Active database marker in the multi-DB explorer.** When the schema-explorer
  filter is scoped to a database (the HeidiSQL-style behaviour shipped in 1.0.2),
  that database now carries an emerald dot and icon while the other databases are
  dimmed, so it's obvious at a glance which database the filter will hit — no
  longer only inferable from the filter input placeholder. With no database
  active (cross-DB / MongoDB-style search) every database stays at full opacity,
  since they're all in scope.

### Changed

- **Themeable brand accent.** The previously all-neutral palette gains one
  saturated accent colour reserved for action / state — primary buttons, focus
  rings, links, and the live-connection markers. It's a per-theme `brand` token
  (themes.ts): the neutral Dark / Light presets get a blue (`#0f83fd`) while the
  themed presets (Claude, Solarized, Dim, High Contrast) keep their own
  character. Custom themes saved before the token existed inherit a CSS default
  rather than breaking. A `prefers-reduced-motion` rule collapses the UI's
  transitions for users who ask for less motion.
- **"Island view" window layout.** The outer panel shell (Schema / Saved /
  Workspace / Console) now lays its panels out as spaced, rounded cards over a
  subtle backdrop instead of edge-to-edge regions, giving each window a small
  margin and clearer separation. The inner tab area (open tables and queries)
  stays flush and unchanged.

### Fixed

- **Duplicate "▶ Run" CodeLens (and duplicate autocomplete entries) with
  multiple query tabs open.** Monaco's `registerCompletionItemProvider` /
  `registerCodeLensProvider` / `registerCommand` are global to the language,
  but they were registered inside every query editor's `onMount`, so each open
  query tab added another provider — N tabs produced N "▶ Run" lenses on every
  statement and N copies of each suggestion. The providers are now installed
  once per Monaco instance (`src/lib/monacoSql.ts`) and dispatch per model via a
  registry each editor registers into on mount and removes on unmount.
- **Inner workspace tab strip readability + active-tab tracking.** The active
  query/table tab now carries a brand-tinted accent and tracks the active panel
  correctly (the custom tab derives its active state from the store rather than
  a stale `props.api.isActive`), the strip is taller with clearer hover states,
  and the close / split (⋮) / new-query (+) icons are legible on dark themes.
- **Incomplete Spanish translation.** Several panels and dialogs still rendered
  English regardless of the selected language. Migrated the Console panel, the
  query editor (history sidebar, tooltips, empty states, run hints), the Saved
  Queries panel, the Save Query dialog, the inline cell input, the connection
  error boundary, the data-grid right-click context menu (copy, copy-row-as,
  set NULL, filter by / excluding value, insert / duplicate / delete row, and
  the multi-row bulk actions), the data-grid toolbar (row filter, row count,
  insert, server-side filter chips) and the table browser toolbar (refresh,
  pagination, page size, loading state and the delete-confirmation dialog) to
  the i18n system. Spanish now covers the whole UI.

## [1.0.2] — 2026-06-02

### Added

- **Import / Export of connection profiles.** Export all or selected profiles to
  a portable JSON file (`File → Export profiles…` or the icons in _Manage
  connections_). Profiles can optionally include credentials: each password and
  SSH secret is encrypted individually with AES-256-GCM, key-derived via
  PBKDF2-HMAC-SHA256 at 600 000 iterations, so the file is safe to store or
  send. Importing detects encryption, walks through a passphrase step when
  needed, shows a conflict-resolution screen when IDs collide (overwrite / skip /
  keep both), and always assigns fresh UUIDs to imported profiles to avoid
  keychain collisions. Profiles imported without passwords are flagged in the
  result summary.
- **CLI connection arguments.** HuginnDB can now be launched with connection
  flags so external tools can open it pre-connected. `--connect-profile <name>`
  auto-connects to a saved profile by display name; `--connect-profile-id <uuid>`
  uses the stable ID instead. For ad-hoc connections without a saved profile:
  `--host`, `--port`, `--database`, `--username`, `--driver`, `--name` — the
  app opens with the profile pre-populated and asks for the password via the
  normal dialog (passwords are never accepted on the CLI). Unknown flags are
  silently ignored for forward compatibility.
- **Scoped multi-DB filter (HeidiSQL-style).** In multi-database connections,
  the schema-explorer filter now scopes to the active database instead of
  searching all databases simultaneously. Expanding a database activates it as
  the filter scope; the search input placeholder updates to "Filter in
  `<db>`…" and a hint below the input confirms the scope while typing. Opening
  a table from cross-DB results automatically activates that database, collapses
  the others, and fixes the scope. With no database expanded the filter falls
  back to the previous behaviour (searches all DBs), keeping the single-DB case
  fully retrocompatible.
- **Visual table-structure editor (HeidiSQL-style).** Right-click a table →
  _Edit structure…_ (or _New table…_) opens an editor for columns
  (add/drop/rename, type, nullability, default, primary key, auto-increment),
  indexes and foreign keys — including composite ones. The column type is an
  editable combobox pre-filled with the driver's common types so you avoid
  typos but can still fine-tune (e.g. `varchar(40)`). It follows a
  preview-and-apply model: the backend generates driver-aware DDL (PostgreSQL /
  MySQL / SQLite) which is shown in a live read-only preview before you apply it
  in one go. On SQLite, changes that `ALTER TABLE` can't express (type /
  nullability / PK / FK edits) fall back to the canonical 12-step table rebuild,
  gated behind an explicit destructive confirmation. All identifiers are
  validated before quoting; types and defaults go through a conservative
  allowlist.
- **Side-panel cell editor (JetBrains-style).** Large cell values can now be
  edited in a docked right-side panel instead of a centered dialog. Reach it via
  right-click → _Open in side editor_, or the new _Move to side panel_ button
  inside the modal editor (it carries the in-progress buffer across). A new
  _General → Cell editor_ preference (`cellEditorMode`: Dialog / Side panel)
  chooses where the editor opens when you expand a cell. The panel is a real
  dockview panel, so it resizes, docks and floats like the others.
- **Multi-row selection with bulk copy and delete.** Pick several rows the way
  your OS file manager works: `Ctrl`/`Cmd`-click toggles individual rows and
  `Shift`-click extends a contiguous range. Right-clicking the selection offers
  _Copy N rows as ▸ JSON / SQL INSERT / SQL UPDATE_ (reusing the existing per-row
  formatters) and _Delete N rows_. Every delete — single or bulk — goes through
  the same confirmation dialog. Selection is keyed by primary key, so it
  survives sorting, client-side filtering and refetches (only available on
  tables with a primary key).
- **Workspace split/float layout now persists per connection.** A two-pane (or
  floating) arrangement inside a workspace is captured as a dockview `toJSON()`
  blob in `tab_state.json` (`internalLayout`) and restored with `fromJSON` on
  reopen, instead of always coming back as plain tabbed panels. Only saved when
  a split actually exists; on any layout drift it falls back to the tabbed
  default.

### Fixed

- **Editing a MySQL `BIT` cell wrote garbage.** `update_cell` sends the value
  as a textual literal and lets the driver coerce it. For `BIT`, MySQL reads the
  string `"1"` as the ASCII byte `0x31` (the character `'1'`) instead of the
  integer 1, so saving a BIT cell silently corrupted it — while `VARCHAR`/`TEXT`
  worked because they accept the string directly. The frontend now forwards the
  column's raw type to `update_cell`, which wraps the placeholder in
  `CAST(? AS UNSIGNED)` for MySQL `BIT` columns (NULL-safe), forcing numeric
  interpretation. PG/SQLite are unchanged.
- **MySQL `TINYINT` (and other non-`i64` integer widths) rendered as `NULL`.**
  sqlx maps each MySQL integer width to a specific Rust type (`TINYINT` → `i8`,
  `… UNSIGNED` → `u8`/`u32`/`u64`, …) and refuses a mismatched `try_get` target,
  so `try_get::<i64>` failed for everything that wasn't signed-64-bit-compatible
  and the cell collapsed to `NULL` — the same class of bug previously fixed for
  `BIT`. `mysql_value` now falls back across the signed and unsigned widths
  before surrendering to `NULL`, so `TINYINT`/`SMALLINT` and unsigned columns
  show their real value. `TINYINT(1)`/`BOOL` still decode as booleans (that
  branch stays above the generic `INT` check).
- **Blank connection panel when clearing a multi-DB filter.** In a multi-database
  connection, typing a filter and then clearing it could blank the entire schema
  panel (the outer File/View/Workspaces toolbar stayed visible). Root cause: a
  `useMemo` in the single-database explorer sat _below_ the `if (!cs) return`
  early return, so when the per-connection schema slice briefly flipped to
  `undefined` while nested explorers unmounted, React rendered a different number
  of hooks across renders and threw. The hook now sits above the early return
  (constant hook count) and the grouping is reference-stable. A new
  `ConnectionErrorBoundary` wraps the schema and workspace panels so any future
  render crash degrades to a legible error card with a retry instead of a dead
  white screen.

## [1.0.1] — 2026-05-30

First patch release. Fixes the MySQL `BIT` rendering that 1.0.0 shipped
broken, and reworks data-grid cell editing into an inline-first flow with a
persisted HeidiSQL-style row zoom. On-disk state is untouched.

### Added

- **Inline cell editing.** Double-clicking a cell in the data grid now edits
  it in place with the same single-line input used by the insert draft row,
  instead of always opening the large Monaco dialog. A _expand_ button on the
  inline editor (and the existing F11 in the cell preview) escalates to the
  full modal for JSON / long / multi-line values. Foreign-key columns keep
  their inline combobox; read-only query results still open the modal as a
  viewer. The plain input + `∅` set-NULL control is now a shared `CellInput`
  component reused by both the draft row and inline editing.
- **Persisted row zoom.** The data grid honours `gridPrefs.rowHeight` (a
  HeidiSQL-style zoom): `Ctrl` + mouse-wheel over the grid and `+`/`−` buttons
  in the table toolbar grow or shrink row height, padding and font-size
  together. The level is stored in `prefs.json` and survives restarts.

### Fixed

- **MySQL `BIT` columns rendered as `NULL`.** `sqlx` refuses to decode a
  `Vec<u8>` from a `MYSQL_TYPE_BIT` column (its blob type-compatibility check
  only accepts BLOB/STRING/VARBINARY), so the value collapsed to `NULL` in the
  grid even though the row held a real value. `mysql_value` now reads the bytes
  straight off the `ValueRef`, folding them big-endian into an integer
  (`BIT(1)` → 0/1, wider `BIT(n)` → its numeric value). Booleans
  (`BOOL` / `TINYINT(1)`) are also now decoded before the generic `INT` check,
  which previously shadowed them.

## [1.0.0] — 2026-05-29

First stable release. The alpha cycle (0.x) closes with the workspace
turning into a code-editor-style surface, the multi-database explorer
becoming instant on the first keystroke, and two MySQL-specific defects
fixed. Existing data on disk (`profiles.json`, `tab_state.json`,
`prefs.json`) is preserved without migration. From here on the project
follows SemVer.

### Added

- **Editor-style workspace.** The open table and query tabs now live in a
  nested dockview instance instead of a flat tab strip, so the workspace
  behaves like a code editor: tabs can be split horizontally or
  vertically, dragged between groups, and torn out into a floating
  window. Tabs can also be closed with a middle-mouse (wheel) click in
  addition to the X button. Each tab also exposes an explicit `⋮` menu
  with _Split right_, _Split down_, _Float in new window_, and _Close_
  for users who prefer menu actions over drag-and-drop. `useTabs` remains
  the source of truth — the dockview panels are reconciled against it —
  so the existing per-connection tab restore keeps working. Split/float
  geometry is session-only; restored tabs come back in the default tabbed
  layout.

- **MySQL `BIT` columns are now configurable in the grid.** A new
  **BIT display** preference (Settings → Grid) renders `BIT` values as
  either `true`/`false` (default) or `0`/`1`. The backend always ships
  the value as a number, so toggling the preference re-renders without
  re-querying.

### Changed

- **Multi-database filtering is now instant.** The connection-level
  filter used to fan out `openDatabaseView` + `list_tables` across every
  database on the _first_ keystroke, so the initial search on a server
  with many databases stalled for seconds. A multi-DB connection now
  warms its entire table cache in the background as soon as the database
  list is known (`warmDatabases` in `src/stores/schema.ts`), with bounded
  concurrency so it never opens every pool at once. The filter reads
  straight from that cache; a subtle progress line shows how many
  databases remain. The previous on-demand prefetch is retained as a
  fallback for databases the warm pass hasn't reached yet.

### Fixed

- **HTML5 drag-and-drop in the workspace was completely broken on
  Windows.** Dragging an editor tab produced the "no drop allowed"
  cursor everywhere on screen — no drop overlay appeared, nothing
  accepted a release. Tauri 2's `dragDropEnabled` defaults to `true`,
  which routes drag events through the OS file-drop handler and preempts
  the HTML5 events dockview's `Droptarget` listeners rely on
  (`tauri-utils` documents this verbatim: _"Disabling it is required to
  use HTML5 drag and drop on the frontend on Windows"_). The window
  config now sets `dragDropEnabled: false`. HuginnDB doesn't accept OS
  file drops anyway (the SQLite path is chosen via a file dialog), so
  there's no functional loss.

- **Split divider between dockview groups was nearly invisible.**
  `.dv-sash` was forced to z-index 1 (so Radix portals always covered
  it) and tinted with `--border`, which on the dark theme blended into
  the panel content. A vertical split looked like nothing had happened
  even when dockview had laid out a new group below. The sash now lives
  at z-index 10 (still safely under Radix at 50) with an explicit
  divider tint, and the drag-over fill jumped from 0.18 to 0.40 alpha so
  the drop quadrants stand out over Monaco / grid surfaces.

- **"Split right" / "Split down" actions in the tab `⋮` menu silently
  did nothing.** They called `panel.api.moveTo({ position })` without a
  `group`, but `DockviewPanelApiImpl.moveTo` coerces `position` to
  `"center"` whenever `options.group` is undefined — moving the panel
  to the centre of its own group is a no-op. Passing the panel's own
  group as the reference makes dockview create a new group adjacent at
  the requested side.

- **MySQL/MariaDB raised error 1064 when filtering a table.** The
  cross-column search clause emitted `... LIKE ? ESCAPE '\'` for every
  driver. On MySQL the backslash inside the string literal escapes the
  closing quote, leaving it unterminated and triggering a syntax error
  (the filter still returned rows because the data and `COUNT(*)`
  queries run separately, but the error banner appeared). The `ESCAPE`
  clause is now driver-aware: MySQL receives `ESCAPE '\\'` (parsed as a
  single backslash, matching `escape_like`), while Postgres/SQLite keep
  the standard-SQL `ESCAPE '\'`. Centralised in a new
  `like_escape_clause` helper used by both the table filter and the FK
  options lookup (`src-tauri/src/commands/query.rs`).

- **MySQL `BIT` columns rendered as NULL.** `mysql_value`
  (`src-tauri/src/db/values.rs`) had no branch for `BIT`, so sqlx's
  binary value fell through to the `String` fallback, failed to decode,
  and surfaced as NULL. A dedicated branch now folds the raw bytes into
  a big-endian unsigned integer and ships it as a number.
