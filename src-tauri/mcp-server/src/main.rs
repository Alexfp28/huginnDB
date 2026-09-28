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
//!       "command": "huginndb-mcp"
//!     }
//!   }
//! }
//! ```
//!
//! No arguments: which connections are reachable is picked in the app under
//! Settings → MCP and re-read per call. `--connections <id>,<id>` still pins an
//! explicit set for one client when that is wanted.
//!
//! A copy that is not the one installed with the app (the `.mcpb` bundle's)
//! hands the session to the installed one first, so updating HuginnDB updates
//! every client's connector — see [`huginndb_lib::mcp::delegate`].

fn main() -> anyhow::Result<()> {
    // Before the runtime, the state, the policy or a single byte on stdout:
    // the installed copy does all of that itself.
    if let Some(code) = huginndb_lib::mcp::delegate::run_installed_if_any() {
        std::process::exit(code);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(huginndb_lib::mcp::serve())
}
