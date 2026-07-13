# MongoDB roadmap

HuginnDB 1.1.0 ships a **read + basic-edit MVP** of the MongoDB driver. This
document tracks what was deliberately deferred, why, and the technical hook each
item depends on, so a future version can pick them up without rediscovering the
context.

See `CLAUDE.md` for the architecture and `src-tauri/src/db/mongo/` for the
driver code. The MVP scope is recorded in `CHANGELOG.md` under 1.1.0.

## Shipped in 1.1.0 (for reference)

- Connect via connection string (`mongodb://` / `mongodb+srv://`), browse
  databases → collections, inspect documents in the grid + JSON cell preview.
- `mongosh`-style editor: `find` / `findOne` / `aggregate` / `countDocuments` /
  `distinct` + write methods, chained `sort/limit/skip/projection`, relaxed JSON
  and common BSON constructors.
- Edit / insert / delete by `_id`; field-type-aware value coercion.
- Read-only structure (inferred fields + indexes); collection drop.
- SSH tunnel for single-host `mongodb://`.

## Deferred

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
`size_bytes` is currently `None` for collections.
- **Why deferred:** exact size needs a `collStats` round-trip per collection,
  an N+1 cost the MVP avoided (it uses the cheap `estimated_document_count` for
  row counts only).
- **Hook:** `db.run_command({collStats: name})` in `list_collections`, ideally
  batched or lazy.

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
The data grid (both the collection browser and query-editor results) labels
every column with the generic type `bson`, even though each field has a concrete
BSON type (`int`, `long`, `string`, `double`, `decimal128`, `date`, `objectId`,
`null`, …). The information already exists — `bson_type_name` maps every BSON
variant, and the read-only **structure view** (`infer_columns`) reports the real
per-field type — but the tabular result path throws it away.
- **Why deferred:** BSON is schemaless, so within one result set a field can
  hold different types across rows; `docs_to_result` sidestepped this by pinning
  a single generic label rather than deciding how to represent a heterogeneous
  column. (See the comment at `db/mongo/query.rs` where `data_type: "bson"` is
  set.)
- **Hook:** infer each column's type in `docs_to_result` (`db/mongo/query.rs`)
  from the returned documents — walk the rows, take `bson_type_name` of the
  first non-null value per field, and fall back to a `mixed` label when the
  non-null values disagree. The same treatment applies to the `distinct`
  result and the `count` scalar (`scalar_result`, currently also `"bson"`).
  `bson_type_name` in `db/mongo/values.rs` already produces the exact labels the
  MongoDB entry of `columnTypesFor` (`src/lib/columnTypes.ts`) expects, so no
  frontend change is needed for the common (uniform) case; only a new `mixed`
  label would be novel to the UI.
