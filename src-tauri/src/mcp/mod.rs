//! Headless MCP (Model Context Protocol) connector.
//!
//! Exposes the databases HuginnDB already knows about (from `profiles.json` +
//! the OS keychain) to an MCP client — Claude Code, Claude Desktop, Cursor, …
//! — over stdio, so an AI assistant can inspect real schema and data instead
//! of guessing. See `docs/MCP_CONNECTOR_ROADMAP.md`.
//!
//! Design (roadmap Option A — headless stdio twin):
//!
//! * **Reuses the desktop backend wholesale.** Every tool delegates to the
//!   same `_inner` data-path functions the Tauri commands call
//!   ([`crate::commands`]); the MCP surface adds no new SQL. Reads go through a
//!   [`NoopSink`]; writes go through an [`AuditSink`] that appends to
//!   `mcp-audit.log`.
//! * **Writes gated by a per-connection policy.** Each exposed connection
//!   carries a saved [`McpWritePolicy`] (`read-only` / `data` / `full`,
//!   default `read-only`), edited in the app's Settings → MCP and persisted in
//!   `profiles.json`. The sidecar re-reads it **fresh from disk on every write
//!   attempt** ([`Huginn::write_policy`]), so changing a connection's level in
//!   the app takes effect without restarting the MCP client. `run_query`
//!   classifies each statement ([`crate::db::sql::classify`]) and the
//!   structured write tools (`insert_row` / `update_cell` / `delete_rows`)
//!   require at least `data`; DDL requires `full`. A global `--read-only`
//!   kill-switch forces read-only regardless of saved policy. (The old
//!   `--allow-writes` flag is deprecated and inert.)
//! * **Opt-in per profile.** Nothing is reachable until the user names a
//!   profile id via `--connections id1,id2`. An empty allowlist exposes
//!   nothing.
//! * **Lazy pools.** No database is touched until a tool call names a
//!   connection; the pool is then opened via [`crate::db::pool::open_pool`]
//!   (password from the keychain) and cached in the shared [`AppState`]. It is
//!   a separate process from the running desktop app — it does not share the
//!   GUI's live pools.
//! * **Row cap.** `--max-rows` (default [`DEFAULT_MAX_ROWS`]) bounds how many
//!   rows a single `run_query` / `browse_table` call can return, so a tool
//!   call can't dump a whole table into the model's context.

use std::collections::HashSet;
use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt};
use serde::Deserialize;

use crate::db::sql::StmtClass;
use crate::error::AppResult;
use crate::log_bus::{LogEntry, LogSink, NoopSink};
use crate::state::{ActivePool, AppState, McpWritePolicy};

/// Default cap on rows returned by a single `run_query` / `browse_table` call.
const DEFAULT_MAX_ROWS: i64 = 1000;

/// Runtime configuration parsed from the process arguments.
struct Config {
    /// Profile ids the client is allowed to reach. Opt-in: empty means
    /// nothing is exposed.
    allowed: HashSet<String>,
    /// Global read-only kill-switch (`--read-only`). When set, every
    /// connection is forced to [`McpWritePolicy::ReadOnly`] regardless of its
    /// saved per-connection policy — a way to expose the sidecar in a
    /// guaranteed-safe mode without editing any profile. Default `false`
    /// (the per-connection policy governs).
    read_only: bool,
    /// Upper bound on rows returned per call.
    max_rows: i64,
    /// Whether the deprecated `--allow-writes` flag was seen, so `serve` can
    /// emit a one-time deprecation notice. It no longer grants anything — the
    /// per-connection [`McpWritePolicy`] (Settings → MCP) is the sole authority.
    saw_allow_writes: bool,
}

impl Config {
    /// Parse `--connections a,b,c`, `--read-only`, `--max-rows N`, and the
    /// deprecated `--allow-writes` from `argv` (program name at index 0).
    /// Accepts both `--flag value` and `--flag=value`, mirroring the desktop
    /// CLI parser.
    fn from_args(argv: &[String]) -> Self {
        let mut allowed = HashSet::new();
        let mut read_only = false;
        let mut max_rows = DEFAULT_MAX_ROWS;
        let mut saw_allow_writes = false;

        let args: Vec<String> = argv.iter().skip(1).cloned().collect();
        let mut iter = args.iter().peekable();
        while let Some(raw) = iter.next() {
            let (flag, inline) = match raw.split_once('=') {
                Some((f, v)) => (f, Some(v.to_string())),
                None => (raw.as_str(), None),
            };
            let value =
                |iter: &mut std::iter::Peekable<std::slice::Iter<'_, String>>| -> Option<String> {
                    inline.clone().or_else(|| iter.next().cloned())
                };
            match flag {
                "--connections" | "--connection" => {
                    if let Some(v) = value(&mut iter) {
                        for id in v.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                            allowed.insert(id.to_string());
                        }
                    }
                }
                "--read-only" | "--readonly" => {
                    // Bare `--read-only` means true; `--read-only=false` is
                    // honoured for explicit config files.
                    read_only =
                        !matches!(inline.as_deref(), Some("false") | Some("0") | Some("no"));
                }
                "--allow-writes" => {
                    // Deprecated and inert: writes are now governed per
                    // connection by the saved `McpWritePolicy`. Consume any
                    // attached value so it isn't mis-parsed as a positional.
                    let _ = inline;
                    saw_allow_writes = true;
                }
                "--max-rows" => {
                    if let Some(v) = value(&mut iter).and_then(|v| v.parse::<i64>().ok()) {
                        if v > 0 {
                            max_rows = v;
                        }
                    }
                }
                _ => {}
            }
        }

        Config {
            allowed,
            read_only,
            max_rows,
            saw_allow_writes,
        }
    }
}

/// Deserialize an optional integer that may arrive as a JSON number *or* a
/// numeric string. Some MCP clients serialize `limit`/`offset` arguments as
/// strings despite the tool schema advertising `integer` — accepting either
/// keeps `browse_table` usable instead of hard-rejecting a client's
/// serialization quirk with an opaque deserialization error.
fn lenient_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrString {
        Num(i64),
        Str(String),
    }
    match Option::<NumOrString>::deserialize(deserializer)? {
        None => Ok(None),
        Some(NumOrString::Num(n)) => Ok(Some(n)),
        Some(NumOrString::Str(s)) => s
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

/// Tool-argument shapes. Each derives [`Deserialize`] (so the `Parameters`
/// wrapper can parse the JSON-RPC `arguments`) and `JsonSchema` via rmcp's
/// re-exported `schemars` (so the tool advertises a schema to the client).
mod args {
    use super::Deserialize;

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Connection {
        /// Profile id of a database exposed to this server (see
        /// `list_connections`).
        pub connection_id: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Tables {
        pub connection_id: String,
        /// For MongoDB only: the database to list collections from, when the
        /// connection has no database bound; see [`Table::schema`]. Ignored
        /// for SQL drivers (a connection is already bound to one database).
        #[serde(default)]
        pub schema: Option<String>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Table {
        pub connection_id: String,
        /// Schema / namespace. Omit for the driver default (Postgres
        /// `public`, MySQL current database, SQLite `main`). For MongoDB,
        /// this is the **database name** — required when the connection has
        /// no database bound (see `list_connections`' `database` field);
        /// opens (or reuses) a per-database view automatically.
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Query {
        pub connection_id: String,
        /// A single read-only statement: SQL (SELECT / WITH / SHOW / EXPLAIN
        /// / PRAGMA) for Postgres/MySQL/SQLite, or mongosh syntax
        /// (`db.<collection>.find({...})`) for MongoDB. Rejected otherwise
        /// unless the server runs with `--allow-writes`.
        pub sql: String,
        /// MongoDB only: the database `sql`'s `db.<collection>...` should
        /// target, when the connection has no database bound (see
        /// `list_connections`' `database` field). Ignored for SQL drivers.
        #[serde(default)]
        pub database: Option<String>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Browse {
        pub connection_id: String,
        /// Schema / namespace. For MongoDB, this is the **database name** —
        /// required when the connection has no database bound; see
        /// [`Table::schema`].
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Max rows to return this page. Clamped to the server's `--max-rows`.
        /// Accepts a JSON number, or (leniently) a numeric string — some MCP
        /// clients serialize integer arguments as strings.
        #[serde(default, deserialize_with = "super::lenient_opt_i64")]
        pub limit: Option<i64>,
        /// Rows to skip (pagination offset). Same lenient number parsing as
        /// `limit`.
        #[serde(default, deserialize_with = "super::lenient_opt_i64")]
        pub offset: Option<i64>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Privileges {
        pub connection_id: String,
        /// User/role as returned by `list_users` (MySQL: `user@host`).
        pub user: String,
    }

    /// Hand-written schema for a PK scalar value: a JSON string, number,
    /// boolean or null. `serde_json::Value`'s derived schema is the bare
    /// boolean `true` ("matches anything") — valid JSON Schema, but some MCP
    /// clients' `tools/list` ingestion assumes every (sub-)schema node is an
    /// object and chokes on it, silently dropping every tool for that
    /// session (see CHANGELOG / issue #83). This constrains the advertised
    /// shape to what a PK value actually is without touching the Rust type
    /// (still `serde_json::Value` end-to-end, so deserialization/handlers
    /// are unaffected).
    fn pk_scalar_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": ["string", "number", "boolean", "null"]
        })
    }

    fn pk_values_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let item = pk_scalar_schema(generator);
        schemars::json_schema!({
            "type": "array",
            "items": item
        })
    }

    fn pk_value_rows_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let item = pk_values_schema(generator);
        schemars::json_schema!({
            "type": "array",
            "items": item
        })
    }

    /// One column/value pair for `insert_row`. Mirrors the desktop
    /// `RowValue` (values travel as text; the driver casts to the column
    /// type). Split out with its own `JsonSchema` so the tool advertises a
    /// schema — the command-layer `RowValue` derives only `Deserialize`.
    ///
    /// `#[schemars(inline)]`: without it, schemars hoists this struct into a
    /// root-level `$defs` entry and references it via `$ref` from
    /// `InsertRow.values`'s `items` — the first `$ref`/`$defs` shape in this
    /// server's `tools/list` output, and (per issue #83) a shape some MCP
    /// clients' schema ingestion doesn't expect. Inlining keeps the object
    /// schema written directly where it's used.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    #[schemars(inline)]
    pub struct RowValueArg {
        /// Column name.
        pub column: String,
        /// Value as text; `null` writes a SQL `NULL`. Omitted columns fall
        /// back to their database default.
        #[serde(default)]
        pub value: Option<String>,
        /// Optional raw column type (e.g. `"BIT"`) so drivers that need
        /// special binding get it right; safe to omit.
        #[serde(default)]
        pub column_type: Option<String>,
    }

    /// Arguments for the `insert_row` write tool.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct InsertRow {
        pub connection_id: String,
        /// Schema / namespace (see [`Table::schema`]; MongoDB database name).
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// PK column to recover the generated id via `RETURNING` (Postgres);
        /// MySQL/SQLite report the last insert id automatically.
        #[serde(default)]
        pub pk_column: Option<String>,
        /// Columns to populate.
        pub values: Vec<RowValueArg>,
    }

    /// Arguments for the `update_cell` write tool — updates one column of the
    /// single row addressed by the full primary key.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct UpdateCell {
        pub connection_id: String,
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Ordered PK column names (composite keys supported).
        pub pk_columns: Vec<String>,
        /// PK values parallel to `pk_columns`, identifying the one row.
        #[schemars(schema_with = "pk_values_schema")]
        pub pk_values: Vec<serde_json::Value>,
        /// Column to update.
        pub column: String,
        /// New value as text; `null` sets SQL `NULL`.
        #[serde(default)]
        pub value: Option<String>,
        /// Optional raw column type (e.g. `"BIT"`); safe to omit.
        #[serde(default)]
        pub column_type: Option<String>,
    }

    /// Arguments for the `delete_rows` write tool. Each entry in
    /// `pk_value_rows` is one full-PK tuple, parallel to `pk_columns`.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct DeleteRows {
        pub connection_id: String,
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Ordered PK column names (composite keys supported).
        pub pk_columns: Vec<String>,
        /// One PK-value tuple per row to delete, each parallel to
        /// `pk_columns`.
        #[schemars(schema_with = "pk_value_rows_schema")]
        pub pk_value_rows: Vec<Vec<serde_json::Value>>,
    }
}

/// The MCP server. `Clone` (cheap — everything is behind `Arc`) as required by
/// the tool router.
#[derive(Clone)]
pub struct Huginn {
    state: Arc<AppState>,
    config: Arc<Config>,
    tool_router: ToolRouter<Self>,
}

/// Serialise a backend DTO into a text tool result.
fn ok_json<T: serde::Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// Map a backend [`crate::error::AppError`] onto an MCP error.
fn to_err(e: crate::error::AppError) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

/// File name of the append-only audit log for MCP writes.
const AUDIT_FILE: &str = "mcp-audit.log";

/// Resolve the audit-log path: `<config-dir>/HuginnDB/mcp-audit.log`, the same
/// directory `profiles.json` lives in. Returns `None` if no config dir is
/// available (audit then silently degrades to no-op — it must never fail a
/// write).
fn audit_log_path() -> Option<std::path::PathBuf> {
    dirs::config_dir()
        .map(|base| base.join(crate::app_identity::APP_DIR).join(AUDIT_FILE))
}

/// [`LogSink`] that appends a line to `mcp-audit.log` for every write the
/// sidecar performs (both successes and failures — the shared `_inner` cores
/// emit a [`LogEntry`] on each path). Reads use a [`NoopSink`] instead, so the
/// audit log is a clean record of state-changing operations only.
///
/// Since the sidecar can't show an interactive permission prompt (it's a
/// headless process the MCP client spawns), this log — plus the per-action
/// approval the MCP client itself asks for — is the accountability mechanism:
/// the user can see exactly which writes ran, against which connection, and
/// what they touched. Emission is fire-and-forget: any I/O error is swallowed
/// so it can never fail the originating DB operation.
struct AuditSink {
    path: Option<std::path::PathBuf>,
}

impl AuditSink {
    fn new() -> Self {
        Self {
            path: audit_log_path(),
        }
    }
}

impl LogSink for AuditSink {
    fn log(&self, entry: LogEntry) {
        use std::io::Write;
        let Some(path) = &self.path else { return };
        let outcome = match (&entry.error, entry.rows_affected) {
            (Some(err), _) => format!("ERROR {err}"),
            (None, Some(n)) => format!("rows={n}"),
            (None, None) => "ok".to_string(),
        };
        let line = format!(
            "{} conn={} driver={} {} sql={}\n",
            entry.timestamp_ms,
            entry.connection_id.as_deref().unwrap_or("-"),
            entry.driver.as_deref().unwrap_or("-"),
            outcome,
            entry.sql.as_deref().unwrap_or("-"),
        );
        // Best-effort append; ignore any failure (see the struct doc).
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[tool_router]
impl Huginn {
    fn new(state: Arc<AppState>, config: Arc<Config>) -> Self {
        Self {
            state,
            config,
            tool_router: Self::tool_router(),
        }
    }

    /// Ensure a live pool exists for `id`, opening one lazily on first use.
    ///
    /// Enforces the allowlist, resolves the password (and any SSH secret) from
    /// the OS keychain, and caches the pool in the shared [`AppState`] with no
    /// keepalive heartbeat (a short-lived headless process doesn't need one).
    async fn ensure_connected(&self, id: &str) -> AppResult<()> {
        if !self.config.allowed.contains(id) {
            return Err(crate::error::AppError::InvalidInput(format!(
                "connection {id:?} is not exposed to this MCP server (pass --connections {id})"
            )));
        }
        if self.state.connections.read().contains(id) {
            return Ok(());
        }
        let profile = self
            .state
            .profiles
            .read()
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| crate::error::AppError::NotFound(format!("profile {id}")))?;

        let password = crate::commands::connection::resolve_password(&profile)?;
        let ssh_secret = match profile.ssh_keyring_account() {
            Some(account) => crate::keychain::get_password(&account)?,
            None => None,
        };
        let known_hosts = self.state.known_hosts.clone();
        let (pool, ssh_handle) =
            crate::db::pool::open_pool(&profile, &password, ssh_secret, known_hosts).await?;
        self.state.connections.write().insert(
            profile.id.clone(),
            ActivePool {
                pool,
                _ssh: ssh_handle,
                _keepalive: None,
            },
        );
        Ok(())
    }

    /// Resolve which connection id a table-scoped (or `run_query`) call
    /// should actually address. For every driver except MongoDB this is
    /// always just `connection_id` unchanged — `schema` only ever meant a
    /// SQL namespace within the already-connected database. For MongoDB,
    /// `connection_id` may have no database bound at all (a multi-database
    /// connection, `list_connections`' `database: ""`) — the desktop app
    /// handles this by opening a synthetic per-database pool when the user
    /// expands a database in the explorer
    /// ([`crate::commands::connection::open_database_view`]); the MCP server
    /// has no equivalent gesture, so `schema` (or `run_query`'s `database`)
    /// is the caller's only way to say which database a Mongo table/query
    /// call targets. Reuses the same pure, headless-safe resolver the
    /// desktop command calls into
    /// ([`crate::commands::connection::resolve_mongo_database_view`]).
    async fn resolve_mongo_target(
        &self,
        connection_id: &str,
        schema: Option<&str>,
    ) -> Result<String, ErrorData> {
        let is_mongo = matches!(
            self.state.connections.read().get(connection_id),
            Some(crate::state::DbPool::Mongo(_))
        );
        match schema {
            Some(db) if is_mongo && !db.is_empty() => {
                crate::commands::connection::resolve_mongo_database_view(
                    &self.state,
                    connection_id,
                    db,
                )
                .await
                .map_err(to_err)
            }
            _ => Ok(connection_id.to_string()),
        }
    }

    /// The write policy in force for `connection_id`, read **fresh from
    /// `profiles.json`** so a change made in the desktop app (Settings → MCP)
    /// takes effect without restarting the MCP client. Falls back to the
    /// in-memory profile loaded at startup if the disk re-read fails, and to
    /// [`McpWritePolicy::ReadOnly`] if the profile is unknown. The global
    /// `--read-only` kill-switch overrides everything.
    fn write_policy(&self, connection_id: &str) -> McpWritePolicy {
        if self.config.read_only {
            return McpWritePolicy::ReadOnly;
        }
        crate::store::load_profiles()
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.id == connection_id))
            .map(|p| p.mcp_write)
            .or_else(|| {
                self.state
                    .profiles
                    .read()
                    .iter()
                    .find(|p| p.id == connection_id)
                    .map(|p| p.mcp_write)
            })
            .unwrap_or_default()
    }

    /// Enforce that `connection_id`'s policy admits a statement of tier
    /// `class`, returning an MCP error naming the current level otherwise.
    fn require_class(&self, connection_id: &str, class: StmtClass) -> Result<(), ErrorData> {
        let policy = self.write_policy(connection_id);
        if policy.allows(class) {
            return Ok(());
        }
        let needed = match class {
            StmtClass::Read => "read-only",
            StmtClass::DataWrite => "data",
            StmtClass::Ddl => "full",
        };
        Err(ErrorData::invalid_params(
            format!(
                "connection {connection_id:?} has MCP write policy {:?}, which does not permit \
                 this operation (needs at least {needed:?}). Raise the connection's level in \
                 HuginnDB → Settings → MCP.",
                policy.label()
            ),
            None,
        ))
    }

    #[tool(description = "List the databases this server is allowed to reach \
                          (profile id, name, driver, host, database, whether a \
                          pool is currently open, and the MCP write policy in \
                          force: read-only / data / full).")]
    async fn list_connections(&self) -> Result<CallToolResult, ErrorData> {
        #[derive(serde::Serialize)]
        struct Conn {
            id: String,
            name: String,
            driver: String,
            host: String,
            database: String,
            active: bool,
            /// Effective write policy (`read-only` / `data` / `full`), read
            /// fresh so it reflects the current Settings → MCP choice and the
            /// global `--read-only` kill-switch.
            write_policy: &'static str,
        }
        let active: HashSet<String> = self.state.connections.read().ids().into_iter().collect();
        // Collect the allowed ids first, then resolve each policy through
        // `write_policy` (which re-reads profiles.json) without holding the
        // `profiles` read-lock across the call.
        let ids: Vec<crate::state::ConnectionProfile> = self
            .state
            .profiles
            .read()
            .iter()
            .filter(|p| self.config.allowed.contains(&p.id))
            .cloned()
            .collect();
        let conns: Vec<Conn> = ids
            .into_iter()
            .map(|p| Conn {
                write_policy: self.write_policy(&p.id).label(),
                id: p.id.clone(),
                name: p.name.clone(),
                driver: format!("{:?}", p.driver).to_lowercase(),
                host: p.host.clone(),
                database: p.database.clone(),
                active: active.contains(&p.id),
            })
            .collect();
        ok_json(&conns)
    }

    #[tool(description = "List databases/schemas/catalogs on a connection.")]
    async fn list_databases(
        &self,
        Parameters(a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let out = crate::commands::schema::list_databases_inner(&self.state, &a.connection_id)
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "List tables and views on a connection, with \
                          approximate row counts and sizes where available. \
                          For MongoDB, pass `schema` (the database name) when \
                          the connection has no database bound — otherwise \
                          this returns an empty list.")]
    async fn list_tables(
        &self,
        Parameters(a): Parameters<args::Tables>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        let out = crate::commands::schema::list_tables_inner(&self.state, &target)
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "Describe a table's full structure: columns, types, \
                          nullability, primary key, foreign keys, and indexes.")]
    async fn describe_table(
        &self,
        Parameters(a): Parameters<args::Table>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        let out = crate::commands::structure::get_table_structure_inner(
            &self.state,
            &target,
            a.schema,
            a.table,
        )
        .await
        .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "List indexes on a table, with the columns each covers.")]
    async fn list_indexes(
        &self,
        Parameters(a): Parameters<args::Table>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        let out =
            crate::commands::schema::list_indexes_inner(&self.state, &target, a.schema, a.table)
                .await
                .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "Run a single statement. Reads (SELECT / WITH / SHOW / \
                          EXPLAIN / PRAGMA for SQL; find/aggregate/countDocuments/\
                          distinct for MongoDB) always work. Writes require the \
                          connection's MCP write policy to allow them: row-level \
                          DML (INSERT/UPDATE/DELETE) needs 'data', schema changes \
                          (CREATE/DROP/ALTER/…) need 'full'. Whole-table \
                          UPDATE/DELETE with no WHERE are refused. Rows are capped \
                          by the server's --max-rows.")]
    async fn run_query(
        &self,
        Parameters(a): Parameters<args::Query>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.database.as_deref())
            .await?;

        // Classify the statement into its required tier. The classifier is
        // driver-aware: plain-SQL keyword matching (`db::sql::classify`) never
        // recognises mongosh syntax (`db.coll.find({...})` starts with none of
        // select/with/show/explain/pragma), so MongoDB is classified via
        // `MongoOp::is_read()` — the same classifier the desktop query editor
        // relies on. Mongo has no DDL path through this parser (only
        // collection-level read/write ops), so a Mongo write is always
        // `DataWrite`.
        let is_mongo = matches!(
            self.state.connections.read().get(&target),
            Some(crate::state::DbPool::Mongo(_))
        );
        let class = if is_mongo {
            if crate::db::mongo::shell::parse(&a.sql)
                .map_err(to_err)?
                .op
                .is_read()
            {
                StmtClass::Read
            } else {
                StmtClass::DataWrite
            }
        } else {
            crate::db::sql::classify(&a.sql)
        };

        // Refuse whole-table UPDATE/DELETE outright (SQL drivers), regardless
        // of tier — a classic AI footgun; the user can add `WHERE 1=1` to opt in.
        if !is_mongo && crate::db::sql::is_unfiltered_write(&a.sql) {
            return Err(ErrorData::invalid_params(
                "run_query refused a whole-table UPDATE/DELETE (no WHERE clause). \
                 Add a WHERE predicate — use `WHERE 1=1` if you really mean every row."
                    .to_string(),
                None,
            ));
        }

        // Policy is a property of the *profile* (`ConnectionProfile::mcp_write`),
        // not of the resolved pool: for Mongo, `target` may be the synthetic
        // per-database id `<connection_id>::db::<name>` (see
        // `resolve_mongo_target`), which is never a key in `profiles.json` — a
        // `write_policy` lookup against it would always miss and silently fall
        // back to `ReadOnly`, regardless of the connection's real setting.
        self.require_class(&a.connection_id, class)?;

        // Reads are not audited; writes append to mcp-audit.log.
        let audit = AuditSink::new();
        let noop = NoopSink;
        let sink: &dyn LogSink = if class == StmtClass::Read {
            &noop
        } else {
            &audit
        };
        let mut result =
            crate::commands::query::execute_with_state(sink, &self.state, &target, &a.sql)
                .await
                .map_err(to_err)?;
        truncate_rows(&mut result, self.config.max_rows);
        ok_json(&result)
    }

    #[tool(description = "Browse one page of rows from a table without writing \
                          SQL. Returns columns + rows; limit is clamped to the \
                          server's --max-rows.")]
    async fn browse_table(
        &self,
        Parameters(a): Parameters<args::Browse>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        let limit = a
            .limit
            .unwrap_or(self.config.max_rows)
            .clamp(1, self.config.max_rows);
        let offset = a.offset.unwrap_or(0).max(0);
        let result = crate::commands::query::fetch_table_data_inner(
            &NoopSink,
            &self.state,
            target,
            a.schema,
            a.table,
            limit,
            offset,
            None,
            None,
            None,
            None,
            Some(true),
        )
        .await
        .map_err(to_err)?;
        ok_json(&result)
    }

    #[tool(description = "Return the connected server's engine and version.")]
    async fn server_version(
        &self,
        Parameters(a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let out = crate::commands::schema::server_version_inner(&self.state, &a.connection_id)
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "List server-side users/roles (permission context).")]
    async fn list_users(
        &self,
        Parameters(a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let out = crate::commands::schema::list_users_inner(&self.state, &a.connection_id)
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "List the privileges granted to a user/role.")]
    async fn list_privileges(
        &self,
        Parameters(a): Parameters<args::Privileges>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let out =
            crate::commands::schema::list_privileges_inner(&self.state, &a.connection_id, a.user)
                .await
                .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        description = "Insert one row into a table. Requires the connection's \
                          MCP write policy to be 'data' or 'full'. Values travel \
                          as text and are cast to each column's type; omitted \
                          columns take their database default. Returns the \
                          generated primary key when available."
    )]
    async fn insert_row(
        &self,
        Parameters(a): Parameters<args::InsertRow>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_class(&a.connection_id, StmtClass::DataWrite)?;
        let values = a
            .values
            .into_iter()
            .map(|v| crate::commands::query::RowValue {
                column: v.column,
                value: v.value,
                column_type: v.column_type,
            })
            .collect();
        let out = crate::commands::query::insert_row_inner(
            &AuditSink::new(),
            &self.state,
            target,
            a.schema,
            a.table,
            a.pk_column,
            values,
        )
        .await
        .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "Update one column of the single row addressed by its \
                          full primary key. Requires the connection's MCP write \
                          policy to be 'data' or 'full'. Refuses to touch more \
                          than one row (an incomplete composite key is an error, \
                          not a silent multi-row update).")]
    async fn update_cell(
        &self,
        Parameters(a): Parameters<args::UpdateCell>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_class(&a.connection_id, StmtClass::DataWrite)?;
        let out = crate::commands::query::update_cell_inner(
            &AuditSink::new(),
            &self.state,
            target,
            a.schema,
            a.table,
            a.pk_columns,
            a.pk_values,
            a.column,
            a.value,
            a.column_type,
        )
        .await
        .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "Delete one or more rows, each addressed by its full \
                          primary key. Requires the connection's MCP write \
                          policy to be 'data' or 'full'. Only rows whose full \
                          key matches a supplied tuple are removed. Returns the \
                          number of rows deleted.")]
    async fn delete_rows(
        &self,
        Parameters(a): Parameters<args::DeleteRows>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_class(&a.connection_id, StmtClass::DataWrite)?;
        let out = crate::commands::query::delete_rows_inner(
            &AuditSink::new(),
            &self.state,
            target,
            a.schema,
            a.table,
            a.pk_columns,
            a.pk_value_rows,
        )
        .await
        .map_err(to_err)?;
        ok_json(&out)
    }
}

/// Truncate a query result to at most `max` rows, flagging the trim in
/// `rows_affected` semantics untouched — callers see fewer rows than the
/// engine returned, so we drop the tail rather than lie about the count.
fn truncate_rows(result: &mut crate::commands::query::QueryResult, max: i64) {
    let max = max.max(0) as usize;
    if result.rows.len() > max {
        result.rows.truncate(max);
    }
}

// `router = self.tool_router` dispatches through the stored router (built once
// in `new`) instead of the macro's default `Self::tool_router()`, which would
// rebuild it on every call and leave the field unread.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Huginn {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo`/`Implementation` are `#[non_exhaustive]`, so build them
        // through the provided constructors/builders rather than struct
        // literals.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "huginndb-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Access to the databases configured in HuginnDB. Call \
                 list_connections first to see which connection ids are available \
                 (each shows its write policy), then pass a connection_id to the \
                 other tools. Reads always work; writes (run_query DML/DDL, \
                 insert_row, update_cell, delete_rows) only succeed when the \
                 connection's policy permits them — 'data' for row changes, \
                 'full' for schema changes — and every write is recorded in the \
                 app's MCP audit log.",
            )
    }
}

/// Run the MCP server over stdio until the client disconnects.
///
/// Builds a headless [`AppState`] (loading `profiles.json` / prefs /
/// known-hosts from disk with no Tauri involvement), parses config from the
/// process arguments, and serves the tool router on stdin/stdout.
pub async fn serve() -> anyhow::Result<()> {
    let argv: Vec<String> = std::env::args().collect();
    let config = Config::from_args(&argv);

    // A one-line startup banner on stderr (stdout is the JSON-RPC channel and
    // must stay clean). Helps confirm which connections were exposed.
    if config.saw_allow_writes {
        eprintln!(
            "[huginndb-mcp] note: --allow-writes is deprecated and ignored. Writes are now \
             governed per connection by the write policy set in HuginnDB → Settings → MCP."
        );
    }
    if config.allowed.is_empty() {
        eprintln!(
            "[huginndb-mcp] no connections exposed — pass --connections <profile-id>[,<id>...]"
        );
    } else {
        let mut ids: Vec<&String> = config.allowed.iter().collect();
        ids.sort();
        eprintln!(
            "[huginndb-mcp] exposing {} connection(s): {} (write policy: per-connection{}, max-rows: {})",
            ids.len(),
            ids.iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            if config.read_only {
                ", forced read-only via --read-only"
            } else {
                ""
            },
            config.max_rows,
        );
    }

    let state = Arc::new(AppState::new());
    let server = Huginn::new(state, Arc::new(config));
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{query, schema};
    use crate::state::{ActivePool, DbPool};

    fn args(v: &[&str]) -> Vec<String> {
        // Prepend a dummy program name; Config::from_args skips argv[0].
        std::iter::once("huginndb-mcp".to_string())
            .chain(v.iter().map(|s| s.to_string()))
            .collect()
    }

    #[test]
    fn config_defaults_expose_nothing() {
        let c = Config::from_args(&args(&[]));
        assert!(c.allowed.is_empty(), "opt-in: no connections by default");
        assert!(!c.read_only);
        assert!(!c.saw_allow_writes);
        assert_eq!(c.max_rows, DEFAULT_MAX_ROWS);
    }

    #[test]
    fn config_parses_connections_read_only_and_max_rows() {
        let c = Config::from_args(&args(&[
            "--connections",
            "alpha, beta ,gamma",
            "--read-only",
            "--max-rows=50",
        ]));
        assert!(c.allowed.contains("alpha"));
        assert!(c.allowed.contains("beta"));
        assert!(c.allowed.contains("gamma"));
        assert_eq!(c.allowed.len(), 3);
        assert!(c.read_only);
        assert_eq!(c.max_rows, 50);
    }

    #[test]
    fn config_read_only_false_is_honoured() {
        let c = Config::from_args(&args(&["--read-only=false"]));
        assert!(!c.read_only);
    }

    #[test]
    fn config_allow_writes_is_deprecated_and_inert() {
        // The flag is recognised only so `serve` can warn; it grants nothing.
        let c = Config::from_args(&args(&["--allow-writes"]));
        assert!(c.saw_allow_writes);
        assert!(!c.read_only, "deprecated flag must not affect policy");
    }

    #[test]
    fn write_policy_maps_tiers_correctly() {
        use crate::state::McpWritePolicy::*;
        assert!(ReadOnly.allows(StmtClass::Read));
        assert!(!ReadOnly.allows(StmtClass::DataWrite));
        assert!(!ReadOnly.allows(StmtClass::Ddl));
        assert!(Data.allows(StmtClass::Read));
        assert!(Data.allows(StmtClass::DataWrite));
        assert!(!Data.allows(StmtClass::Ddl));
        assert!(Full.allows(StmtClass::Read));
        assert!(Full.allows(StmtClass::DataWrite));
        assert!(Full.allows(StmtClass::Ddl));
    }

    /// Build a `Huginn` around an in-memory profile carrying `policy`, exposed
    /// to the server. `write_policy` re-reads `profiles.json` first, but the
    /// synthetic id is not on disk, so it falls back to this in-memory profile
    /// — letting us exercise `require_class` without touching real state.
    fn huginn_with_policy(id: &str, policy: McpWritePolicy, read_only: bool) -> Huginn {
        let state = AppState::new();
        state
            .profiles
            .write()
            .push(crate::state::ConnectionProfile {
                id: id.to_string(),
                name: id.to_string(),
                driver: crate::state::Driver::Sqlite,
                host: String::new(),
                port: 0,
                database: String::new(),
                username: String::new(),
                ssl: false,
                ssh_tunnel: None,
                connection_string: None,
                auth_source: None,
                ephemeral: false,
                group: None,
                visible_databases: None,
                mcp_write: policy,
            });
        let mut allowed = HashSet::new();
        allowed.insert(id.to_string());
        Huginn::new(
            Arc::new(state),
            Arc::new(Config {
                allowed,
                read_only,
                max_rows: DEFAULT_MAX_ROWS,
                saw_allow_writes: false,
            }),
        )
    }

    #[test]
    fn require_class_enforces_per_connection_policy() {
        let ro = huginn_with_policy("t-ro", McpWritePolicy::ReadOnly, false);
        assert!(ro.require_class("t-ro", StmtClass::Read).is_ok());
        assert!(ro.require_class("t-ro", StmtClass::DataWrite).is_err());
        assert!(ro.require_class("t-ro", StmtClass::Ddl).is_err());

        let data = huginn_with_policy("t-data", McpWritePolicy::Data, false);
        assert!(data.require_class("t-data", StmtClass::Read).is_ok());
        assert!(data.require_class("t-data", StmtClass::DataWrite).is_ok());
        assert!(data.require_class("t-data", StmtClass::Ddl).is_err());

        let full = huginn_with_policy("t-full", McpWritePolicy::Full, false);
        assert!(full.require_class("t-full", StmtClass::DataWrite).is_ok());
        assert!(full.require_class("t-full", StmtClass::Ddl).is_ok());
    }

    #[test]
    fn read_only_kill_switch_overrides_full_policy() {
        // Even a `full` connection is forced read-only when --read-only is set.
        let killed = huginn_with_policy("t-kill", McpWritePolicy::Full, true);
        assert!(killed.require_class("t-kill", StmtClass::Read).is_ok());
        assert!(killed
            .require_class("t-kill", StmtClass::DataWrite)
            .is_err());
        assert!(killed.require_class("t-kill", StmtClass::Ddl).is_err());
    }

    async fn mongo_client() -> mongodb::Client {
        // Parsing + `with_options` only validate and spawn the driver's
        // background monitor tasks — no reachable server is required.
        let options = mongodb::options::ClientOptions::parse("mongodb://127.0.0.1:1")
            .await
            .expect("valid connection string");
        mongodb::Client::with_options(options).expect("client construction is lazy")
    }

    /// Regression test for the bug reported against a real `data`-policy Mongo
    /// connection: `write_policy` must be checked against the *profile* id
    /// (`a.connection_id`), never against `resolve_mongo_target`'s resolved
    /// pool id. For a multi-database Mongo connection (empty top-level
    /// `database`, `list_connections`' `database: ""`), a table/query call
    /// naming a `schema`/`database` resolves to the synthetic per-database id
    /// `<connection_id>::db::<name>` (`database_view_id`) — which is never a
    /// key in `profiles.json`. Checking the policy against that id used to
    /// make `write_policy` miss the lookup and silently fall back to
    /// `ReadOnly`, blocking every write on a `data`/`full` connection the
    /// moment the caller named a specific database.
    #[tokio::test]
    async fn write_policy_is_checked_against_the_real_connection_not_the_mongo_db_binding() {
        let huginn = huginn_with_policy("mongo-conn", McpWritePolicy::Data, false);
        let client = mongo_client().await;
        huginn.state.connections.write().insert(
            "mongo-conn".to_string(),
            ActivePool {
                pool: DbPool::Mongo(crate::state::MongoConn {
                    client,
                    database: None,
                }),
                _ssh: None,
                _keepalive: None,
            },
        );

        let target = huginn
            .resolve_mongo_target("mongo-conn", Some("iMesPyme"))
            .await
            .unwrap();
        assert_eq!(target, "mongo-conn::db::iMesPyme");

        // The bug: `require_class(&target, ...)` would find no profile named
        // `"mongo-conn::db::iMesPyme"` and default to ReadOnly.
        assert!(
            huginn.require_class(&target, StmtClass::DataWrite).is_err(),
            "sanity check: the synthetic id is never a profile id"
        );

        // The fix: callers gate on the real connection id, which does carry
        // the connection's actual `data` policy.
        assert!(huginn
            .require_class("mongo-conn", StmtClass::DataWrite)
            .is_ok());
    }

    /// Exercises the exact classifier `run_query` uses to gate MongoDB
    /// statements: `MongoOp::is_read()` on the parsed statement, not
    /// `db::sql::is_read_only`'s plain-SQL keyword match (which never
    /// recognises mongosh syntax and used to reject every Mongo read).
    #[test]
    fn mongo_run_query_gate_classifies_reads_and_writes() {
        use crate::db::mongo::shell::parse;

        for read in [
            "db.users.find({})",
            "db.users.findOne({_id: 1})",
            "db.users.aggregate([{$match: {a: 1}}])",
            "db.users.countDocuments({})",
            "db.users.distinct('name')",
        ] {
            assert!(
                parse(read).unwrap().op.is_read(),
                "expected read-only: {read:?}"
            );
        }

        for write in [
            "db.users.insertOne({a: 1})",
            "db.users.updateOne({}, {$set: {a: 1}})",
            "db.users.deleteMany({})",
            "db.users.replaceOne({}, {a: 1})",
        ] {
            assert!(
                !parse(write).unwrap().op.is_read(),
                "expected write: {write:?}"
            );
        }
    }

    /// Some MCP clients serialize `limit`/`offset` as JSON strings despite
    /// the advertised `integer` schema — `browse_table` used to hard-reject
    /// those calls with an opaque deserialization error.
    #[test]
    fn browse_args_accept_limit_as_number_or_string() {
        let from_number: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":200}"#).unwrap();
        assert_eq!(from_number.limit, Some(200));

        let from_string: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":"200"}"#).unwrap();
        assert_eq!(from_string.limit, Some(200));

        let absent: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t"}"#).unwrap();
        assert_eq!(absent.limit, None);

        let explicit_null: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":null}"#).unwrap();
        assert_eq!(explicit_null.limit, None);

        let invalid: Result<args::Browse, _> =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":"not-a-number"}"#);
        assert!(invalid.is_err());
    }

    /// End-to-end exercise of the Tauri-independent `_inner` data path against
    /// a real (file-backed) SQLite database — the first coverage of the `db`
    /// layer without the GUI (roadmap testing item). Uses a temp file rather
    /// than `sqlite::memory:` so the schema is shared across pooled
    /// connections.
    #[tokio::test]
    async fn sqlite_inner_data_path_end_to_end() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let path = std::env::temp_dir().join("huginndb_mcp_inner_test.db");
        let _ = std::fs::remove_file(&path);
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO widget (name) VALUES ('alpha'), ('beta'), ('gamma')")
            .execute(&pool)
            .await
            .unwrap();

        let state = AppState::new();
        state.connections.write().insert(
            "test-conn".to_string(),
            ActivePool {
                pool: DbPool::Sqlite(pool),
                _ssh: None,
                _keepalive: None,
            },
        );

        // list_tables_inner sees the table.
        let tables = schema::list_tables_inner(&state, "test-conn")
            .await
            .unwrap();
        assert!(tables.iter().any(|t| t.name == "widget"));

        // execute_with_state runs a read through the NoopSink path.
        let res = query::execute_with_state(
            &NoopSink,
            &state,
            "test-conn",
            "SELECT COUNT(*) AS n FROM widget",
        )
        .await
        .unwrap();
        assert_eq!(res.rows.len(), 1);

        // fetch_table_data_inner paginates + counts.
        let page = query::fetch_table_data_inner(
            &NoopSink,
            &state,
            "test-conn".to_string(),
            None,
            "widget".to_string(),
            10,
            0,
            None,
            None,
            None,
            None,
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(page.total, Some(3));
        assert_eq!(page.rows.len(), 3);

        let _ = std::fs::remove_file(&path);
    }

    /// Regression test for issue #83: the write tools' input schemas must
    /// stay free of `$ref`/`$defs` and bare-boolean subschemas, since at
    /// least one MCP client's `tools/list` ingestion chokes on those shapes
    /// and silently drops every tool for the session — even though the
    /// server itself considers the schema valid (rmcp only checks the root
    /// is `type: object`).
    #[test]
    fn write_tool_schemas_avoid_ref_and_bare_boolean_subschemas() {
        let tools = Huginn::tool_router().list_all();
        for name in ["insert_row", "update_cell", "delete_rows"] {
            let tool = tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("tool {name} missing from tool_router"));
            assert_eq!(
                tool.input_schema.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "{name}: root schema must stay type:object (rmcp's own invariant)"
            );
            let raw = serde_json::to_string(tool.input_schema.as_ref()).unwrap();
            assert!(
                !raw.contains("\"$ref\""),
                "{name}: schema must not use $ref: {raw}"
            );
            assert!(
                !raw.contains("\"$defs\""),
                "{name}: schema must not use $defs: {raw}"
            );
            assert!(
                !raw.contains("\"items\":true") && !raw.contains("\"items\": true"),
                "{name}: schema must not have a bare-boolean items subschema: {raw}"
            );
        }
    }
}
