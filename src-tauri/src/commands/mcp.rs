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

/// Best-effort check for whether the `huginndb-mcp` sidecar is currently
/// running — i.e. some external MCP client (Claude Code, Cursor, Antigravity,
/// ...) has spawned it and may be relying on it right now. The desktop app
/// never starts or stops this process itself (see gotcha #20/#23 in
/// CLAUDE.md), so the only signal available is asking the OS's own process
/// list — there is no IPC channel to the sidecar to ask it directly.
///
/// Used by the update flow to warn the user before installing: the Windows
/// NSIS installer hook (`windows/hooks.nsi`) force-kills this process
/// unconditionally so the update can overwrite it, and previously did so
/// silently. Shells out to the platform's own process-listing tool rather
/// than pulling in a process-inspection crate, to keep the dependency tree
/// small. Any failure to run the check (missing tool, unexpected output)
/// degrades to `false` — an update should never be blocked by an inconclusive
/// check, only warned when the sidecar is positively detected.
#[tauri::command]
pub fn is_mcp_sidecar_running() -> bool {
    let name = if cfg!(windows) {
        "huginndb-mcp.exe"
    } else {
        "huginndb-mcp"
    };
    if cfg!(windows) {
        let filter = format!("IMAGENAME eq {name}");
        std::process::Command::new("tasklist")
            .args(["/FI", filter.as_str(), "/NH"])
            .output()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .to_lowercase()
                    .contains(name.to_lowercase().as_str())
            })
            .unwrap_or(false)
    } else {
        std::process::Command::new("pgrep")
            .args(["-x", name])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}
