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
//!   ([`crate::commands`]); the MCP surface adds no new SQL. A [`NoopSink`]
//!   stands in for the GUI's Console log.
//! * **Read-only by default (v1).** `run_query` rejects anything
//!   [`crate::db::sql::is_read_only`] doesn't recognise unless `--allow-writes`
//!   is passed — and no write tools are registered regardless, so v1 is
//!   read-only end to end.
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

use crate::error::AppResult;
use crate::log_bus::NoopSink;
use crate::state::{ActivePool, AppState};

/// Default cap on rows returned by a single `run_query` / `browse_table` call.
const DEFAULT_MAX_ROWS: i64 = 1000;

/// Runtime configuration parsed from the process arguments.
struct Config {
    /// Profile ids the client is allowed to reach. Opt-in: empty means
    /// nothing is exposed.
    allowed: HashSet<String>,
    /// Whether non-read-only SQL is permitted through `run_query`. v1 leaves
    /// this `false`; even when `true` no dedicated write tools are registered.
    allow_writes: bool,
    /// Upper bound on rows returned per call.
    max_rows: i64,
}

impl Config {
    /// Parse `--connections a,b,c`, `--allow-writes[=true|false]`, and
    /// `--max-rows N` from `argv` (program name at index 0). Accepts both
    /// `--flag value` and `--flag=value`, mirroring the desktop CLI parser.
    fn from_args(argv: &[String]) -> Self {
        let mut allowed = HashSet::new();
        let mut allow_writes = false;
        let mut max_rows = DEFAULT_MAX_ROWS;

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
                "--allow-writes" => {
                    // Bare `--allow-writes` means true; `--allow-writes=false`
                    // is honoured for explicit config files.
                    allow_writes = match inline.as_deref() {
                        None | Some("true") | Some("1") | Some("yes") => true,
                        _ => false,
                    };
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
            allow_writes,
            max_rows,
        }
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
    pub struct Table {
        pub connection_id: String,
        /// Schema / namespace. Omit for the driver default (Postgres
        /// `public`, MySQL current database, SQLite `main`).
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Query {
        pub connection_id: String,
        /// A single read-only SQL statement (SELECT / WITH / SHOW / EXPLAIN /
        /// PRAGMA). Rejected otherwise unless the server runs with
        /// `--allow-writes`.
        pub sql: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Browse {
        pub connection_id: String,
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Max rows to return this page. Clamped to the server's `--max-rows`.
        #[serde(default)]
        pub limit: Option<i64>,
        /// Rows to skip (pagination offset).
        #[serde(default)]
        pub offset: Option<i64>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Privileges {
        pub connection_id: String,
        /// User/role as returned by `list_users` (MySQL: `user@host`).
        pub user: String,
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

        let password = crate::keychain::require_password(&profile.keyring_account())?;
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

    #[tool(description = "List the databases this server is allowed to reach \
                          (profile id, name, driver, host, database, and \
                          whether a pool is currently open).")]
    async fn list_connections(&self) -> Result<CallToolResult, ErrorData> {
        #[derive(serde::Serialize)]
        struct Conn {
            id: String,
            name: String,
            driver: String,
            host: String,
            database: String,
            active: bool,
        }
        let active: HashSet<String> = self.state.connections.read().ids().into_iter().collect();
        let conns: Vec<Conn> = self
            .state
            .profiles
            .read()
            .iter()
            .filter(|p| self.config.allowed.contains(&p.id))
            .map(|p| Conn {
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
                          approximate row counts and sizes where available.")]
    async fn list_tables(
        &self,
        Parameters(a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let out = crate::commands::schema::list_tables_inner(&self.state, &a.connection_id)
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
        let out = crate::commands::structure::get_table_structure_inner(
            &self.state,
            &a.connection_id,
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
        let out = crate::commands::schema::list_indexes_inner(
            &self.state,
            &a.connection_id,
            a.schema,
            a.table,
        )
        .await
        .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(description = "Run a single read-only SQL statement (SELECT / WITH / \
                          SHOW / EXPLAIN / PRAGMA). Rows are capped by the \
                          server's --max-rows.")]
    async fn run_query(
        &self,
        Parameters(a): Parameters<args::Query>,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.config.allow_writes && !crate::db::sql::is_read_only(&a.sql) {
            return Err(ErrorData::invalid_params(
                "run_query only accepts read-only statements (SELECT/WITH/SHOW/\
                 EXPLAIN/PRAGMA); this server runs read-only"
                    .to_string(),
                None,
            ));
        }
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let mut result = crate::commands::query::execute_with_state(
            &NoopSink,
            &self.state,
            &a.connection_id,
            &a.sql,
        )
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
        let limit = a
            .limit
            .unwrap_or(self.config.max_rows)
            .clamp(1, self.config.max_rows);
        let offset = a.offset.unwrap_or(0).max(0);
        let result = crate::commands::query::fetch_table_data_inner(
            &NoopSink,
            &self.state,
            a.connection_id,
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
                "Read-only access to the databases configured in HuginnDB. Call \
                 list_connections first to see which connection ids are available, \
                 then pass a connection_id to the other tools.",
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
    if config.allowed.is_empty() {
        eprintln!(
            "[huginndb-mcp] no connections exposed — pass --connections <profile-id>[,<id>...]"
        );
    } else {
        let mut ids: Vec<&String> = config.allowed.iter().collect();
        ids.sort();
        eprintln!(
            "[huginndb-mcp] exposing {} connection(s): {} (writes: {}, max-rows: {})",
            ids.len(),
            ids.iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            config.allow_writes,
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
        assert!(!c.allow_writes);
        assert_eq!(c.max_rows, DEFAULT_MAX_ROWS);
    }

    #[test]
    fn config_parses_connections_writes_and_max_rows() {
        let c = Config::from_args(&args(&[
            "--connections",
            "alpha, beta ,gamma",
            "--allow-writes",
            "--max-rows=50",
        ]));
        assert!(c.allowed.contains("alpha"));
        assert!(c.allowed.contains("beta"));
        assert!(c.allowed.contains("gamma"));
        assert_eq!(c.allowed.len(), 3);
        assert!(c.allow_writes);
        assert_eq!(c.max_rows, 50);
    }

    #[test]
    fn config_allow_writes_false_is_honoured() {
        let c = Config::from_args(&args(&["--allow-writes=false"]));
        assert!(!c.allow_writes);
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
}
