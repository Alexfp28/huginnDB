//! MCP connector introspection.
//!
//! The `huginndb-mcp` binary lives in its own workspace crate (see
//! `mcp-server/` and gotcha #20 in `CLAUDE.md`) and ships as a Tauri
//! `externalBin` sidecar — installed side-by-side with the main executable,
//! never invoked by the desktop app itself. This command only resolves
//! *where that sidecar ended up on disk* so the Settings → MCP panel can
//! show the user a ready-to-use path instead of sending them hunting
//! through the install directory.

use crate::error::AppResult;
use serde::Serialize;

#[derive(Serialize)]
pub struct McpConnectorInfo {
    /// Best-guess absolute path to the `huginndb-mcp` sidecar binary.
    pub binary_path: String,
    /// Whether a file actually exists at `binary_path`. False in `tauri dev`
    /// / an unbundled `cargo run` — the sidecar is only staged in a
    /// packaged install (or a manual `cargo build -p huginndb-mcp --release`
    /// followed by `pnpm tauri:build`).
    pub available: bool,
}

/// Resolve the sidecar's path: Tauri stages `externalBin` binaries in the
/// same directory as the main executable, so `current_exe()`'s parent is
/// the one place to look, independent of the OS/bundle format.
#[tauri::command]
pub fn get_mcp_connector_info() -> AppResult<McpConnectorInfo> {
    let file_name = if cfg!(windows) {
        "huginndb-mcp.exe"
    } else {
        "huginndb-mcp"
    };
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(file_name)))
        .unwrap_or_else(|| file_name.into());
    let available = path.is_file();
    Ok(McpConnectorInfo {
        binary_path: path.to_string_lossy().into_owned(),
        available,
    })
}
