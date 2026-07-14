//! `huginndb-mcp` — headless MCP server binary.
//!
//! A thin shim over [`huginndb_lib::mcp::serve`]; all the logic lives in the
//! library crate (`../src/mcp/`) so it can reach the shared, Tauri-independent
//! data-path functions. A separate workspace member from the tauri app on
//! purpose — see this crate's `Cargo.toml` for why. Build with:
//! `cargo build -p huginndb-mcp --release` (from `src-tauri/`).
//!
//! Launched by an MCP client over stdio, e.g.:
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "huginndb": {
//!       "command": "huginndb-mcp",
//!       "args": ["--connections", "<profile-id>"]
//!     }
//!   }
//! }
//! ```

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    huginndb_lib::mcp::serve().await
}
