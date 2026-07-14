# MongoDB roadmap

The MongoDB driver started as a **read + basic-edit MVP** in HuginnDB 1.1.0.
This document tracks what is done and what was deliberately deferred — with the
technical hook each deferred item depends on — so the eventual "complete the
MongoDB driver" pass can lean on it without rediscovering the context.

See `CLAUDE.md` for the architecture and `src-tauri/src/db/mongo/` for the
driver code. Per-release scope lives in `CHANGELOG.md`.

**Status legend:** ✅ done · ⏳ deferred (still open as of 1.7.2).

## Done (as of 1.7.2)

Verified against the 1.7.2 tree; grouped by the version that shipped it.

### 1.1.0 — MVP
- Connect via connection string (`mongodb://` / `mongodb+srv://`), browse
  databases → collections, inspect documents in the grid + JSON cell preview
  (`db/mongo/mod.rs`, `schema.rs`).
- `mongosh`-style editor: `find` / `findOne` / `aggregate` / `countDocuments` /
  `distinct` + the write methods (`insertOne/Many`, `updateOne/Many`,
  `replaceOne`, `deleteOne/Many`), chained `.sort()/.limit()/.skip()/.projection()`,
  relaxed JSON and common BSON constructors (`shell.rs`, `query.rs`).
- Edit / insert / delete by `_id`; field-type-aware value coercion (`query.rs`,
  `values.rs`).
- Read-only structure (inferred fields + real indexes); collection drop
  (`schema.rs::table_structure`).
- SSH tunnel for single-host `mongodb://`; CLI `--driver mongodb` +
  `--uri`/`--connection-string`.

### 1.1.1 — connection UX
- Field-driven connection form (Compass-style) that builds the URI live, with an
  **Edit connection string** escape hatch for cases the form can't express.
- Dedicated **auth source** field + CLI `--auth-source`.

### 1.4.0 — introspection
- Users & privileges introspection for the Security panel via `usersInfo`
  (`schema.rs::list_users` / `list_privileges`).

### 1.6.x — data grid parity
- Multi-column sort in the browse path (multi-key sort document, from the
  ordered `order` list on the fetch command).
- Skips `count_documents` on pure sort/page changes, mirroring the SQL
  `COUNT(*)` skip (`with_count` flag).

### 1.7.0 — multi-DB connections
- Multi-database connections show a name in the title bar instead of a blank
  breadcrumb (#51).
- Opening a MongoDB connection with no preselected database no longer errors:
  `list_collections` returns `[]` at the cluster level, mirroring the SQL
  drivers, instead of failing the whole tree (#52).

### 1.7.2 — multi-DB + MCP parity
Closes the gaps #51/#52 left open, and generalizes the MCP connector
(`huginndb-mcp`, see `docs/MCP_CONNECTOR_ROADMAP.md`) for MongoDB, which had
been getting noticeably less attention than the SQL drivers.

- **Security panel in multi-DB connections.** `list_users`/`list_privileges`
  (`schema.rs`) still called `resolve_db(conn)?` unconditionally — the #52 fix
  only covered `list_collections`, not these two sibling functions, so opening
  the Security tab on a cluster-level connection (no database selected) still
  threw "no database selected". Both now run cluster-wide via `usersInfo` with
  `forAllDBs: true` against the `admin` database when no database is selected
  (mirroring `ping()`'s existing cluster-level probe), falling back to today's
  per-database behavior otherwise.
- **MCP `run_query` no longer blocks MongoDB reads.** The read-only gate in
  `mcp/mod.rs` used the plain-SQL keyword classifier
  (`db::sql::is_read_only`, recognising only `select/with/show/explain/pragma`)
  before dispatching — a mongosh read like `db.coll.find({...})` never matches
  any of those, so **every** MongoDB `run_query` call was rejected by default,
  unless the server ran with the global `--allow-writes` flag (which also
  unlocks real SQL writes). The desktop query editor never had this problem
  because it dispatches Mongo before the generic gate and lets
  `MongoOp::is_read()` (`shell.rs`) classify the statement; `run_query` now
  does the same for Mongo connections.
- **Per-column BSON type in query/browse results** (was deferred item #11
  below — see its former write-up for the reasoning). `docs_to_result` /
  `scalar_result` / the `distinct` result in `db/mongo/query.rs` now infer each
  column's real BSON type (`int`, `string`, `date`, `objectId`, …, or `mixed`
  on disagreement) instead of the generic `"bson"` label — this also improves
  what an MCP client sees from `run_query`/`browse_table`.
- **Collection size in the explorer** (was deferred item #7 below). A single
  `$collStats` aggregation run at the database level (`db.aggregate([{$collStats:
  {storageStats: {}}}])`) returns storage stats for every collection in one
  round trip, avoiding the N+1 cost the original deferral was worried about.
  Best-effort: an older server or an insufficiently-privileged role just leaves
  sizes unknown instead of failing the listing.
- **MCP tools can finally target a database on a multi-DB MongoDB connection.**
  A real-world MCP session against a multi-DB Mongo connection surfaced that
  `list_tables`, `describe_table`, `list_indexes`, and `browse_table` all
  accepted (or, for `list_tables`, didn't even have) a `schema` parameter that
  was silently **ignored** for MongoDB in `list_tables_inner` /
  `get_table_structure_inner` / `list_indexes_inner` / `fetch_table_data_inner`
  — every call on a database-less connection failed with "no database
  selected", with no way to say which database to use. `run_query` hit the
  identical error for a bare `db.coll.find()`, and had no parameter for a
  database at all. The desktop app solves this with `open_database_view`
  (`commands/connection.rs`), which opens a synthetic per-database pool
  (`<id>::db::<name>`) when a user expands a database in the explorer — the
  MCP server had no equivalent gesture. The Mongo half of that function needed
  no `AppHandle`/`Window` to begin with (a single `mongodb::Client` reaches
  every database; it's a client clone + database re-tag, no re-auth), so it's
  now a shared free function (`resolve_mongo_database_view`) the MCP server
  calls whenever `schema` (or `run_query`'s new `database` parameter) names a
  database for a Mongo connection with none bound. `getSiblingDB(...)`
  mid-statement support was considered and deliberately deferred — it needs
  the executor itself to switch databases per-statement, a bigger change than
  a resolved-at-call-time parameter; see item #9 below if revisited.
- **`browse_table`'s `limit`/`offset` now tolerate a numeric string.** Not a
  MongoDB-specific bug, but found in the same live session: some MCP clients
  serialize integer arguments as JSON strings despite the advertised
  `integer` schema, and `serde`'s strict typing rejected `"200"` outright.
  Both fields now accept either a JSON number or a numeric string.

**Remaining MCP/MongoDB gap, deliberately not addressed here:** `describe_table`
still reports the heuristic, sample-based columns from `infer_columns` (no real
catalog to read, unlike the SQL drivers — see item #9's schema-variance note for
the related idea of surfacing sample confidence), and the MCP server has no
per-driver capability negotiation — every tool advertises identically
regardless of which driver a connection uses. Both are real generalization
work but a larger scope than this pass; flagging them here rather than in
`docs/MCP_CONNECTOR_ROADMAP.md`, which is scoped to the (now fully-implemented)
MCP server build-out itself, not per-driver tool quality.

## Deferred (⏳ still open as of 1.7.2)

### 1. Index editor
Create / drop / alter indexes from the structure editor (currently read-only).
- **Why deferred:** the structure editor is built around SQL DDL diffing
  (`db/ddl.rs`); MongoDB needs a parallel apply path (`createIndex` /
  `dropIndex`) rather than generated SQL.
- **Hook:** `db/mongo/schema.rs` already reads indexes via `list_indexes`; add a
  mongo branch to `apply_structure_change` that diffs `IndexDef`s and issues
  `create_index` / `drop_index`.

### 2. JSON Schema validator editor
View and edit a collection's `$jsonSchema` validator.
- **Why deferred:** needs a dedicated editor surface (Monaco JSON) and a
  `collMod` apply path; out of scope for the MVP's read-only structure view.
- **Hook:** `db.run_command({collMod, validator})`; read the current validator
  from `listCollections` options.

### 3. Typed `_id` round-trip
Today a displayed `_id` is reconstructed heuristically (a 24-hex-char string is
treated as an `ObjectId`). A genuine 24-hex-character *string* `_id` is the one
ambiguous case.
- **Why deferred:** display renders `ObjectId` as a bare hex string for
  readability (`bson_to_json`); making it unambiguous on write needs the field's
  `_id` BSON type threaded into `update_cell`/`delete_rows`.
- **Hook:** carry the `_id` type from `infer_columns` into the edit payload, or
  tag `_id` cells with Extended JSON in the result.

### 4. Transactions / sessions
Multi-document transactions (require a replica set).
- **Why deferred:** the SQL batch path uses a single pooled connection with
  user-driven `BEGIN/COMMIT`; MongoDB needs an explicit `ClientSession` with
  `start_transaction` / `commit_transaction`.
- **Hook:** `Client::start_session`; thread a session through the mongo CRUD
  helpers in `db/mongo/query.rs`.

### 5. Profile transfer / export for MongoDB
Include MongoDB profiles (and their connection strings) in encrypted
export/import.
- **Why deferred:** the connection string can embed credentials; the export
  encryption (`transfer.rs`) was designed around the keychain password/SSH
  secret split and needs a decision on how to treat an inline-credential URI.
- **Hook:** `transfer.rs` `ExportedSecret`; decide whether to strip/encrypt the
  URI's userinfo.

### 6. SRV + SSH tunnel
Tunnel `mongodb+srv://` (Atlas) connections.
- **Why deferred:** an SRV record resolves via DNS to several replica-set hosts;
  the current single-port tunnel (`db/ssh.rs`) can front only one host.
- **Hook:** resolve the SRV record manually, open one tunnel per resolved host,
  and rewrite `ClientOptions.hosts` to the local endpoints with
  `direct_connection = false`.

### 7. Collection size in the explorer
✅ **Fixed in 1.7.2 — see the "1.7.2 — multi-DB + MCP parity" entry above.**
(Number kept stable so cross-references elsewhere don't drift.)

### 8. Table ⇄ JSON view toggle
A dedicated per-tab toggle between the flattened table grid and a raw
document/JSON list view.
- **Why deferred:** nested values already render as JSON in the grid cell and
  expand in the `CellPreview` panel, which covers the common case; a dedicated
  toggle is polish.
- **Hook:** `TableDataTab.tsx` + the existing `CellPreview` panel.

### 9. Richer query surface
`explain`, `bulkWrite`, `findAndModify`, change streams, GridFS, a visual
aggregation builder, and per-field schema-variance analysis (type distribution
across a sample).
- **Why deferred:** beyond the MVP's bounded `mongosh` grammar
  (`db/mongo/shell.rs`).
- **Hook:** extend the `shell.rs` parser + `query.rs` executor; the parser is
  designed to reject unknown methods with a clear error, so additions are
  additive.

### 10. Proper editor language for MongoDB
The editor reuses Monaco's `sql` language for syntax highlighting; mongosh would
read better with a JavaScript/JSON grammar.
- **Why deferred:** keeping `sql` preserved the existing CodeLens "▶ Run",
  `Ctrl+Enter`, and completion wiring with minimal churn for the MVP.
- **Hook:** `src/lib/monacoSql.ts` providers are language-scoped; register a
  parallel set for `javascript` and switch the model language per driver in
  `QueryEditorTab.tsx`.

### 11. Per-column BSON type in the data grid
✅ **Fixed in 1.7.2 — see the "1.7.2 — multi-DB + MCP parity" entry above.**
(Number kept stable so cross-references elsewhere don't drift.)
