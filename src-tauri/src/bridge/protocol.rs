//! Wire format for the local MCP bridge.
//!
//! Newline-delimited JSON, one object per line, request/response in lockstep on
//! a single connection. Not JSON-RPC: there is exactly one client per
//! connection issuing one call at a time (MCP tools are dispatched serially
//! over stdio), so ids, batching and notifications would all be ceremony with
//! no user.
//!
//! # Shape
//!
//! Every request is one variant of [`BridgeRequest`], mirroring the `_inner`
//! data-path function it dispatches to one-for-one. That deliberate redundancy
//! is what keeps the bridge honest: adding an MCP tool that reaches a new
//! `_inner` function will not compile against the server's exhaustive `match`
//! until the bridge learns about it too, so a tool can never silently keep
//! opening its own pools while the rest of the process is proxying.
//!
//! Results come back as an opaque `serde_json::Value`. The concrete types
//! (`QueryResult`, `Vec<TableInfo>`, …) already round-trip through serde on
//! their way to the MCP client, so re-typing them here would buy nothing but a
//! second place to keep in sync.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped when a request or response shape changes incompatibly.
///
/// The desktop app and the sidecar are built from the same source but installed
/// as separate files, and a packaged install updates them together — except in
/// the one case that matters: a user who built `huginndb-mcp` from source
/// before this, or whose MCP client is still holding an old sidecar process
/// alive across an app update (the exact situation gotcha #23's installer hook
/// exists for). A mismatch must degrade to the local-pool fallback, not to a
/// deserialisation error mid-tool-call.
pub const PROTOCOL_VERSION: u32 = 1;

/// Opening frame. Sent once, before any request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_version: u32,
    pub token: String,
    /// The connection ids this client is allowed to reach — its own
    /// `--connections` allowlist, forwarded so the app can enforce it too.
    ///
    /// Advisory with respect to a *hostile* token-holder, which would simply
    /// declare everything; the per-connection write policy the server re-checks
    /// from disk is the authoritative gate. What this buys is that an honest
    /// sidecar cannot accidentally widen its own exposure by reaching a profile
    /// the user never named.
    #[serde(default)]
    pub allowed: Vec<String>,
}

/// Reply to [`Hello`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAck {
    pub protocol_version: u32,
    /// `None` on success; a reason on refusal (bad token, version mismatch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One proxied data-path call.
///
/// Field names mirror the `_inner` signatures exactly so the dispatch is a
/// transcription rather than a translation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum BridgeRequest {
    /// Open (or reuse) the pool for a connection. Always the first call for a
    /// given connection — it is what moves pool ownership to the app.
    EnsureConnected {
        connection_id: String,
    },
    /// Resolve a Mongo per-database view, returning the id to address.
    ResolveMongoTarget {
        connection_id: String,
        database: String,
    },
    /// Whether the resolved connection is a MongoDB one. Needed by the
    /// sidecar's `run_query` to pick a statement classifier, and it must be
    /// answered by whoever owns the pool.
    IsMongo {
        connection_id: String,
    },
    ListDatabases {
        connection_id: String,
    },
    ListTables {
        connection_id: String,
    },
    GetTableStructure {
        connection_id: String,
        schema: Option<String>,
        table: String,
    },
    ListIndexes {
        connection_id: String,
        schema: Option<String>,
        table: String,
    },
    ServerVersion {
        connection_id: String,
    },
    ListUsers {
        connection_id: String,
    },
    ListPrivileges {
        connection_id: String,
        user: String,
    },
    /// Execute one statement. `class` is the tier the sidecar classified it as;
    /// the server re-derives it rather than trusting it (see
    /// [`crate::bridge`]'s security notes) and uses the caller's value only to
    /// cross-check.
    RunStatement {
        connection_id: String,
        /// The *profile* id the policy applies to, which for a Mongo
        /// per-database view differs from `connection_id`.
        policy_id: String,
        sql: String,
    },
    FetchTableData {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        limit: i64,
        offset: i64,
        with_count: Option<bool>,
    },
    InsertRow {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_column: Option<String>,
        values: Value,
    },
    UpdateCell {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_columns: Vec<String>,
        pk_values: Vec<Value>,
        column: String,
        value: Option<String>,
        column_type: Option<String>,
    },
    DeleteRows {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_columns: Vec<String>,
        pk_value_rows: Vec<Vec<Value>>,
    },
}

impl BridgeRequest {
    /// Whether this call can change data on the server.
    ///
    /// Drives the sidecar's no-retry rule: a transport failure on a mutating
    /// call must never be retried against a local pool, because the write may
    /// already have landed and only the reply was lost.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    pub fn is_mutating(&self) -> bool {
        match self {
            // `RunStatement` carries arbitrary SQL, so it is treated as
            // mutating regardless of what it looks like — the classifier lives
            // on the other side, and guessing here would be exactly the kind of
            // cleverness that double-writes.
            BridgeRequest::RunStatement { .. }
            | BridgeRequest::InsertRow { .. }
            | BridgeRequest::UpdateCell { .. }
            | BridgeRequest::DeleteRows { .. } => true,
            BridgeRequest::EnsureConnected { .. }
            | BridgeRequest::ResolveMongoTarget { .. }
            | BridgeRequest::IsMongo { .. }
            | BridgeRequest::ListDatabases { .. }
            | BridgeRequest::ListTables { .. }
            | BridgeRequest::GetTableStructure { .. }
            | BridgeRequest::ListIndexes { .. }
            | BridgeRequest::ServerVersion { .. }
            | BridgeRequest::ListUsers { .. }
            | BridgeRequest::ListPrivileges { .. }
            | BridgeRequest::FetchTableData { .. } => false,
        }
    }

    /// Short label for the Console entry the app logs when it serves this.
    pub fn label(&self) -> &'static str {
        match self {
            BridgeRequest::EnsureConnected { .. } => "ensure_connected",
            BridgeRequest::ResolveMongoTarget { .. } => "resolve_mongo_target",
            BridgeRequest::IsMongo { .. } => "is_mongo",
            BridgeRequest::ListDatabases { .. } => "list_databases",
            BridgeRequest::ListTables { .. } => "list_tables",
            BridgeRequest::GetTableStructure { .. } => "get_table_structure",
            BridgeRequest::ListIndexes { .. } => "list_indexes",
            BridgeRequest::ServerVersion { .. } => "server_version",
            BridgeRequest::ListUsers { .. } => "list_users",
            BridgeRequest::ListPrivileges { .. } => "list_privileges",
            BridgeRequest::RunStatement { .. } => "run_query",
            BridgeRequest::FetchTableData { .. } => "browse_table",
            BridgeRequest::InsertRow { .. } => "insert_row",
            BridgeRequest::UpdateCell { .. } => "update_cell",
            BridgeRequest::DeleteRows { .. } => "delete_rows",
        }
    }
}

/// One reply. Exactly one of the two fields is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

impl BridgeResponse {
    pub fn ok(value: Value) -> Self {
        Self {
            ok: Some(value),
            err: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: None,
            err: Some(message.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_through_the_wire_format() {
        let req = BridgeRequest::UpdateCell {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: Some("public".into()),
            table: "t".into(),
            pk_columns: vec!["id".into()],
            pk_values: vec![Value::from(1)],
            column: "name".into(),
            value: Some("x".into()),
            column_type: None,
        };
        let line = serde_json::to_string(&req).unwrap();
        let back: BridgeRequest = serde_json::from_str(&line).unwrap();
        assert!(matches!(back, BridgeRequest::UpdateCell { .. }));
        // Single-line: the framing is newline-delimited, so an embedded newline
        // in the encoding would desynchronise the stream.
        assert!(!line.contains('\n'));
    }

    #[test]
    fn every_write_path_is_marked_mutating() {
        // The no-retry rule depends on this being right; a read misclassified
        // as mutating merely loses a fallback, but a write misclassified as a
        // read can double-apply.
        for req in [
            BridgeRequest::RunStatement {
                connection_id: "c".into(),
                policy_id: "c".into(),
                sql: "SELECT 1".into(),
            },
            BridgeRequest::InsertRow {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_column: None,
                values: Value::Null,
            },
            BridgeRequest::DeleteRows {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_columns: vec![],
                pk_value_rows: vec![],
            },
        ] {
            assert!(req.is_mutating(), "{} must be mutating", req.label());
        }
        assert!(!BridgeRequest::ListTables {
            connection_id: "c".into()
        }
        .is_mutating());
    }
}
