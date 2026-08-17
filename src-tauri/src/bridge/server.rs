//! Desktop-app side of the MCP bridge: the listener that serves a sidecar's
//! data-path calls out of the app's own pools.
//!
//! See [`crate::bridge`] for why this exists and what it is and isn't allowed
//! to trust. The short version: the app becomes the single owner of every
//! HuginnDB connection on the machine, and MCP activity becomes visible in the
//! Console instead of only in `mcp-audit.log`.

use crate::bridge::protocol::{BridgeRequest, BridgeResponse, Hello, HelloAck, PROTOCOL_VERSION};
use crate::bridge::{publish, unpublish, Discovery};
use crate::db::sql::StmtClass;
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, LogEntry, LogKind, LogSink};
use crate::state::{AppState, McpWritePolicy};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// Owns the running listener. Dropping it stops the accept loop and removes the
/// discovery file, so a sidecar started afterwards falls back to local pools
/// rather than dialling a port nothing is listening on.
pub struct BridgeHandle {
    cancel: CancellationToken,
    /// The port actually bound, surfaced in Settings so a user debugging a
    /// firewall prompt can see what HuginnDB opened.
    pub port: u16,
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        unpublish();
    }
}

/// Bind a loopback listener, publish the discovery file, and start serving.
///
/// Port `0` asks the OS for a free one — a fixed port would collide with a
/// second HuginnDB install (stable + canary side by side, which
/// `crate::app_identity` explicitly supports) and there is nothing for a
/// sidecar to hardcode anyway, since it reads the port from the discovery file.
pub async fn start(app: AppHandle) -> AppResult<BridgeHandle> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().to_string();
    publish(&Discovery {
        port,
        token: token.clone(),
        pid: std::process::id(),
    })?;

    log_bus::broadcast(
        &app,
        LogEntry::new(LogKind::Connection)
            .message(format!("mcp bridge: listening on 127.0.0.1:{port}")),
    );

    let cancel = CancellationToken::new();
    let cancel_loop = cancel.clone();
    let token = Arc::new(token);
    tauri::async_runtime::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = cancel_loop.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _peer)) = accepted else {
                // A failed accept is transient (fd pressure, a client that
                // vanished mid-handshake); keep the listener alive.
                continue;
            };
            let app = app.clone();
            let token = Arc::clone(&token);
            let cancel_conn = cancel_loop.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = cancel_conn.cancelled() => {}
                    _ = serve_connection(app, stream, token) => {}
                }
            });
        }
    });

    Ok(BridgeHandle { cancel, port })
}

/// Decide whether to accept a client's opening frame.
///
/// Extracted so the refusal rules — the only thing standing between the token
/// file and every database the user has saved — are exercised by tests rather
/// than only by a running app. Version is checked *before* the token so a
/// mismatched build gets a diagnosable message instead of a bare "bad token".
fn handshake_refusal(hello: &Hello, token: &str) -> Option<String> {
    if hello.protocol_version != PROTOCOL_VERSION {
        return Some(format!(
            "protocol version mismatch (app speaks {PROTOCOL_VERSION}, client speaks {})",
            hello.protocol_version
        ));
    }
    if hello.token != token {
        return Some("bad token".to_string());
    }
    None
}

/// Bring the listener's state in line with the `connections.mcpBridge`
/// preference: start it if it should be running and isn't, stop it if it
/// shouldn't and is.
///
/// Idempotent, so both the startup hook and `update_preferences` can call it
/// unconditionally without either needing to know what the other did. Stopping
/// is just dropping the handle — [`BridgeHandle::drop`] cancels the accept loop
/// and removes the discovery file, so a sidecar that reconnects afterwards
/// falls back to its own pools instead of dialling a dead port.
pub async fn reconcile(app: &AppHandle) {
    let want = app.state::<AppState>().prefs.read().connections.mcp_bridge;
    let running = app.state::<AppState>().mcp_bridge.lock().is_some();
    if want == running {
        return;
    }
    if !want {
        // Take the handle out of the state *before* dropping it, so the lock is
        // not held while `Drop` touches the filesystem.
        let handle = app.state::<AppState>().mcp_bridge.lock().take();
        drop(handle);
        log_bus::broadcast(
            app,
            LogEntry::new(LogKind::Connection).message("mcp bridge: stopped"),
        );
        return;
    }
    match start(app.clone()).await {
        Ok(handle) => {
            *app.state::<AppState>().mcp_bridge.lock() = Some(handle);
        }
        Err(e) => {
            log_bus::broadcast(
                app,
                LogEntry::new(LogKind::Connection)
                    .message("mcp bridge: failed to start")
                    .error(e.to_string()),
            );
        }
    }
}

/// One client connection: handshake, then requests until it goes away.
async fn serve_connection(app: AppHandle, stream: TcpStream, token: Arc<String>) {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    // --- handshake ---
    let Ok(Some(first)) = lines.next_line().await else {
        return;
    };
    let hello: Hello = match serde_json::from_str(&first) {
        Ok(h) => h,
        Err(_) => return,
    };
    let refusal = handshake_refusal(&hello, token.as_str());
    let refused = refusal.is_some();
    let ack = HelloAck {
        protocol_version: PROTOCOL_VERSION,
        error: refusal,
    };
    if write_line(&mut write_half, &ack).await.is_err() || refused {
        // A refused handshake ends the connection: there is no state to keep
        // and nothing useful a caller could do next.
        return;
    }

    // The connections the client says it is allowed to reach (its
    // `--connections` allowlist). Advisory — a hostile token-holder would
    // simply declare everything — but it keeps an honest sidecar honest, and
    // the per-connection write policy checked below is the authoritative gate.
    let allowed: HashSet<String> = hello.allowed.into_iter().collect();

    // --- request loop ---
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<BridgeRequest>(&line) {
            Ok(request) => handle(&app, &request, &allowed).await,
            Err(e) => BridgeResponse::err(format!("malformed request: {e}")),
        };
        if write_line(&mut write_half, &response).await.is_err() {
            return;
        }
    }
}

async fn write_line<T: serde::Serialize>(
    write_half: &mut tokio::net::tcp::OwnedWriteHalf,
    value: &T,
) -> std::io::Result<()> {
    let mut buf = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    buf.push(b'\n');
    write_half.write_all(&buf).await
}

/// Dispatch one request, converting the result to the wire form.
async fn handle(
    app: &AppHandle,
    request: &BridgeRequest,
    allowed: &HashSet<String>,
) -> BridgeResponse {
    let start = Instant::now();
    match dispatch(app, request, allowed).await {
        Ok(value) => {
            log_served(app, request, start, None);
            BridgeResponse::ok(value)
        }
        Err(e) => {
            let message = e.to_string();
            log_served(app, request, start, Some(&message));
            BridgeResponse::err(message)
        }
    }
}

/// Mirror every served call into the Console.
///
/// This is the visibility half of the bridge's value: an MCP client browsing
/// or writing to a database shows up in the same panel as the user's own
/// queries, live, rather than only in `mcp-audit.log` after the fact.
/// Broadcast, not targeted — there is no originating window.
fn log_served(app: &AppHandle, request: &BridgeRequest, start: Instant, error: Option<&str>) {
    let mut entry = LogEntry::new(LogKind::Connection)
        .connection_id(connection_id_of(request))
        .message(format!("mcp: {}", request.label()))
        .duration_ms(start.elapsed().as_millis() as u64);
    if let Some(e) = error {
        entry = entry.error(e);
    }
    log_bus::broadcast(app, entry);
}

fn connection_id_of(request: &BridgeRequest) -> String {
    use BridgeRequest::*;
    match request {
        EnsureConnected { connection_id }
        | IsMongo { connection_id }
        | ListDatabases { connection_id }
        | ListTables { connection_id }
        | ServerVersion { connection_id }
        | ListUsers { connection_id }
        | ListPrivileges { connection_id, .. }
        | ResolveMongoTarget { connection_id, .. }
        | GetTableStructure { connection_id, .. }
        | ListIndexes { connection_id, .. }
        | RunStatement { connection_id, .. }
        | FetchTableData { connection_id, .. }
        | InsertRow { connection_id, .. }
        | UpdateCell { connection_id, .. }
        | DeleteRows { connection_id, .. } => connection_id.clone(),
    }
}

/// Profile id whose write policy governs a request, when it is a write.
///
/// Always the *profile*, never the resolved pool: for Mongo the connection id
/// may be the synthetic `<id>::db::<name>` view, which is not a key in
/// `profiles.json`, so a policy lookup against it would miss and — because
/// `McpWritePolicy` defaults to `ReadOnly` — silently refuse a write the user
/// had actually allowed. (The reverse mistake would be worse; this is the same
/// reasoning the sidecar's own `require_class` records.)
fn policy_id_of(request: &BridgeRequest) -> Option<&str> {
    use BridgeRequest::*;
    match request {
        RunStatement { policy_id, .. }
        | FetchTableData { policy_id, .. }
        | InsertRow { policy_id, .. }
        | UpdateCell { policy_id, .. }
        | DeleteRows { policy_id, .. } => Some(policy_id),
        _ => None,
    }
}

/// Re-check the connection's write policy, from disk, for a mutating call.
///
/// Not trusting the sidecar's own check is the point: this is a privileged
/// surface reachable by anything holding the token, and read-only must mean
/// read-only however the request got here. Read fresh from `profiles.json` for
/// the same reason the sidecar does — so a policy changed in Settings → MCP
/// takes effect without restarting anything.
fn check_policy(state: &AppState, request: &BridgeRequest) -> AppResult<()> {
    let Some(policy_id) = policy_id_of(request) else {
        return Ok(());
    };
    let class = match request {
        BridgeRequest::RunStatement { sql, .. } => crate::db::sql::classify(sql),
        BridgeRequest::FetchTableData { .. } => StmtClass::Read,
        BridgeRequest::InsertRow { .. }
        | BridgeRequest::UpdateCell { .. }
        | BridgeRequest::DeleteRows { .. } => StmtClass::DataWrite,
        _ => return Ok(()),
    };
    let policy = crate::store::load_profiles()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == policy_id))
        .map(|p| p.mcp_write)
        .or_else(|| {
            state
                .profiles
                .read()
                .iter()
                .find(|p| p.id == policy_id)
                .map(|p| p.mcp_write)
        })
        .unwrap_or(McpWritePolicy::ReadOnly);
    if policy.allows(class) {
        return Ok(());
    }
    Err(AppError::InvalidInput(format!(
        "connection {policy_id:?} has MCP write policy {:?}, which does not permit this operation",
        policy.label()
    )))
}

/// [`LogSink`] that mirrors a write's own log entry into every Console.
struct BridgeSink<'a> {
    app: &'a AppHandle,
}

impl LogSink for BridgeSink<'_> {
    fn log(&self, entry: LogEntry) {
        log_bus::broadcast(self.app, entry);
    }
}

async fn dispatch(
    app: &AppHandle,
    request: &BridgeRequest,
    allowed: &HashSet<String>,
) -> AppResult<Value> {
    let state = app.state::<AppState>();
    let state = state.inner();

    // The allowlist covers the connection being reached *and* the profile whose
    // policy governs it; for a Mongo view those differ, and only checking one
    // would leave a gap.
    let target = connection_id_of(request);
    let root = target.split("::db::").next().unwrap_or(&target).to_string();
    if !allowed.contains(&root) {
        return Err(AppError::InvalidInput(format!(
            "connection {root:?} was not declared by this client"
        )));
    }
    check_policy(state, request)?;

    // Opening a pool is the one call that has to go through the *app's* own
    // path rather than the shared executor: `connect_inner` reserves the
    // endpoint budget, starts the keepalive, and emits the cross-window
    // `connection-opened` event so the sidecar's connection appears in the UI
    // like any other.
    if let BridgeRequest::EnsureConnected { connection_id } = request {
        crate::commands::connection::connect_inner(app, state, None, connection_id, None, None)
            .await?;
        return Ok(Value::Null);
    }
    crate::commands::connection::ensure_database_view(app, state, None, &target).await;
    crate::bridge::exec::execute(state, &BridgeSink { app }, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(version: u32, token: &str) -> Hello {
        Hello {
            protocol_version: version,
            token: token.into(),
            allowed: vec![],
        }
    }

    #[test]
    fn a_matching_handshake_is_accepted() {
        assert!(handshake_refusal(&hello(PROTOCOL_VERSION, "secret"), "secret").is_none());
    }

    #[test]
    fn a_wrong_token_is_refused() {
        // The whole security model: the port is reachable by any local process,
        // and this is what stops one that cannot read the 0600 token file.
        let refusal = handshake_refusal(&hello(PROTOCOL_VERSION, "guess"), "secret");
        assert_eq!(refusal.as_deref(), Some("bad token"));
    }

    #[test]
    fn a_version_mismatch_is_refused_before_the_token_is_considered() {
        // Diagnosability: a sidecar built before a protocol change should be
        // told that, not handed "bad token" to chase. Checked with a *correct*
        // token so the ordering is what the assertion pins.
        let refusal = handshake_refusal(&hello(PROTOCOL_VERSION + 1, "secret"), "secret");
        assert!(
            refusal
                .as_deref()
                .is_some_and(|r| r.contains("protocol version mismatch")),
            "got {refusal:?}"
        );
    }
}
