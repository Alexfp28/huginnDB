# MCP connector roadmap

An **MCP (Model Context Protocol) connector** would let AI coding tools (Claude
Code, Claude Desktop, Cursor, …) query the databases HuginnDB already knows
about, so the assistant can combine day-to-day development with the *actual*
state of the developer's databases (schema, sample rows, row counts, server
version, privileges) instead of guessing.

This document records the intent, the chosen approach, the blast radius, and the
technical hooks so a future session can pick it up without rediscovering the
context. Nothing here is implemented yet — it is a **future** item, parked
deliberately.

See `CLAUDE.md` for the architecture (command layer, `db/` abstraction, security
invariants) and `SECURITY.md` for the input-handling rules this design leans on.

## Why this is a low/medium-effort feature

The codebase is already shaped as if it were going to be exposed over MCP:

1. **All DB I/O lives in typed, driver-agnostic Rust commands**
   (`src-tauri/src/commands/`). Each command maps almost 1:1 onto an MCP tool.
2. **The `db/` layer is already Tauri-independent.** `db::pool::open_pool` takes
   a plain `ConnectionProfile`; `execute_with_state` takes `&AppState` (not a
   Tauri `State` guard); `AppState::new()` loads profiles/prefs/known_hosts from
   disk with no Tauri involvement; `keychain::require_password` is a free
   function. A headless twin can reuse ~90% of the backend as-is.
3. **The security story is half-built already.** `is_read_only(sql)` already
   classifies statements (→ a read-only mode for the AI is nearly free); values
   are always bound; `quote_ident` is catalog-only; DDL goes through
   `validate_ident`/`validate_type`/`validate_default`. The MCP surface adds
   **no new SQL paths** — it calls the same functions.

The one real friction point is logging: `log_bus::emit` currently requires a
Tauri `AppHandle`, so the data-path functions must be decoupled from it before a
headless binary can call them (see Phase 0).

## Chosen approach: Option A — headless MCP binary (stdio)

A second binary in the same crate, `huginndb-mcp`, launched by an MCP client
over **stdio**. It reuses `profiles.json` + the OS keychain + the whole `db/`
layer. **Read-only by default**; writes behind an explicit flag. It is a
*headless twin* — it does **not** share the live pools of the running desktop
app.

```
Claude Code ──stdio (JSON-RPC / MCP)──► huginndb-mcp
                                            │ reuses
                                            ▼
                     store::load_profiles()   keychain::require_password
                     db::pool::open_pool  ──►  DbPool (pg / mysql / sqlite / mongo)
                     commands::*::*_inner(&AppState, …)
```

Trade-off vs. the rejected **Option B** (MCP server embedded in the live Tauri
app over a local socket, sharing the desktop session's open connections):
Option A has zero new network surface, works with the GUI closed, and fits the
current `CSP = null` posture. Option B is the more literal "combine with the DB
I already have open" but costs a local listener + auth token + ~1–2 weeks. Keep
Option B as a possible follow-up if sharing the live session is ever missed.

## Work items

### Phase 0 — abstract the logging sink (~0.5 d)

`log_bus::emit(app, window_label, entry)` requires an `AppHandle`. Introduce a
trait so the data path stops depending on Tauri:

```rust
// log_bus.rs
pub trait LogSink: Send + Sync {
    fn emit(&self, entry: LogEntry);
}
// impls: a Tauri sink (AppHandle + window_label) for the GUI; a NoopSink for MCP.
```

`execute_with_state` and every `log_sql(...)` call take `&dyn LogSink` instead
of `(&AppHandle, &str)`. Mechanical; no behaviour change in the GUI.

### Phase 1 — extract `_inner` functions (~1–1.5 d)

The pattern already exists (`list_columns_inner`, `execute_with_state`).
Replicate it for the commands the MCP will expose: each keeps a 3-line
`#[tauri::command]` wrapper that builds a Tauri `LogSink` and delegates to an
`_inner(state: &AppState, sink: &dyn LogSink, …)` core.

```rust
pub async fn list_tables_inner(state: &AppState, sink: &dyn LogSink, connection_id: &str, /* … */) -> AppResult<…>;

#[tauri::command]
pub async fn list_tables(app: AppHandle, window: tauri::Window, state: State<'_, AppState>, /* … */) -> AppResult<…> {
    list_tables_inner(state.inner(), &TauriSink::new(&app, window.label()), /* … */).await
}
```

Commands to refactor (all others stay untouched): `execute_query`,
`fetch_table_data`, `list_databases`, `list_tables`, `list_columns` (done),
`list_indexes`, `get_table_structure`, `server_version`, `list_users`,
`list_privileges`. Add `insert_row`/`update_cell`/`delete_rows` only if
write-mode ships.

### Phase 2 — the MCP binary (~1–1.5 d)

- **New dependency:** `rmcp` (Anthropic's official Rust MCP SDK; `server` +
  `transport-io` features). This is the only new dependency and needs the
  maintainer's explicit sign-off (small-tree preference). Alternative:
  hand-roll MCP over JSON-RPC/stdio (more code, no dep).
- **Location:** the logic lives in the `mcp/` module of the desktop app's own
  library crate, behind an `mcp` cargo feature; the binary shim
  (`src-tauri/mcp-server/src/main.rs`) is a separate workspace crate so a
  normal `tauri:build` does not compile or bundle it unless asked (moved out
  of a `[[bin]]` in the app's own `Cargo.toml` in 1.7.0 — see `CLAUDE.md`).
- **Startup:** build a headless `AppState` via `AppState::new()`. Open pools
  **lazily** — the first tool call for a given `connection_id` triggers
  `open_pool` with `keychain::require_password(profile.keyring_account())` and
  caches the pool in `state.connections`. No DB is touched until used.
- Output DTOs (`QueryResult`, `ColumnMeta`, `TableStructure`, …) are already
  `Serialize`, so they map straight onto MCP tool `content`.

### Phase 3 — safety + docs (~0.5–1 d)

1. **Read-only by default.** `run_query` rejects when `!is_read_only(sql)`
   unless `--allow-writes`.
2. **Connection allowlist.** `--connections id1,id2` (or an `mcp` block in
   `prefs.json`). Default is **opt-in per profile** — nothing is exposed until
   the user names it.
3. **No new plaintext.** Passwords still come from the keychain via
   `require_password`; the MCP never logs or persists them.
4. **Row cap.** `--max-rows` (default ~1000) so a tool call can't dump a whole
   table into the model's context.
5. Document the client config in `docs/MCP.md`.

### Phase 4 — write-mode with a per-connection permission model (1.9.0)

Shipped as a **per-connection write policy**, not a single global
`--allow-writes` bool. Each profile carries `mcp_write: read-only | data |
full` (default `read-only`), set in Settings → MCP and saved to
`profiles.json`. The sidecar re-reads it fresh on every write attempt, so a
level change in the app takes effect without restarting the MCP client.

- **Classifier** (`db/sql.rs`): `classify()` → `StmtClass::{Read, DataWrite,
  Ddl}`; `read-only` admits Read, `data` adds DataWrite, `full` adds Ddl.
  Whole-table `UPDATE`/`DELETE` (no `WHERE`) refused outright.
- **Tools:** `insert_row` / `update_cell` / `delete_rows` (require ≥ `data`);
  DDL reachable through `run_query` at `full`. A dedicated structure-editor
  tool was deferred (making the model synthesise a full `TableStructure` DTO is
  worse than emitting `ALTER TABLE`).
- **Trust model:** the headless sidecar can't prompt, so per-action approval
  stays with the MCP client; HuginnDB owns *policy* + an **audit log**
  (`mcp-audit.log`, every write). A `--read-only` global kill-switch forces
  read-only regardless of saved policy. `--allow-writes` is deprecated/inert.

Rejected the original sketch (`execute_write` gated behind a global
`--allow-writes`) — a per-connection policy managed in the app is safer and
needs no client-config edits to change.

## Proposed MCP tool surface

| Tool | Backend `_inner` | Notes |
| --- | --- | --- |
| `list_connections` | `store::load_profiles` + `connections.ids()` | which DBs are available |
| `list_databases` | `schema::list_databases_inner` | |
| `list_tables` | `schema::list_tables_inner` | |
| `describe_table` | `structure::get_table_structure_inner` | columns, types, PK, FK, indexes |
| `list_indexes` | `schema::list_indexes_inner` | |
| `run_query` | `execute_query_inner` | rejects non-read-only SQL unless write-mode |
| `browse_table` | `fetch_table_data_inner` | paginated/filtered browse without writing SQL |
| `server_version` | `schema::server_version_inner` | |
| `list_users` / `list_privileges` | `schema::*_inner` | permission context |
| *(opt-in)* `insert_row` / `update_cell` / `delete_rows` / `execute_write` | respective `_inner` | only with `--allow-writes` |

## Client configuration (target UX)

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "huginndb-mcp",
      "args": ["--allow-writes=false", "--connections", "<profile-id>"]
    }
  }
}
```

## Testing

- `cargo test` over the `_inner` functions against a temporary SQLite DB
  (chinook) — no GUI. This is the first real chance to test the `db` layer
  end-to-end (roadmap item 7).
- A test asserting `run_query` rejects an `UPDATE` in read-only mode.

## Effort summary

| Phase | Content | Est. |
| --- | --- | --- |
| 0 | `LogSink` trait + Noop | 0.5 d |
| 1 | extract `_inner` from ~10 commands | 1–1.5 d |
| 2 | `mcp.rs` binary + `rmcp` + read tools | 1–1.5 d |
| 3 | safety (read-only, allowlist, max-rows) + docs | 0.5–1 d |
| 4 *(opt)* | write-mode + write tools | +0.5–1 d |

**Read-only v1: ~3–4 days.** Clean history: a `refactor:` commit per Phase 0/1,
a `feat:` for the binary.

## Open decisions (resolve before writing code)

1. **Add `rmcp`?** Only new dependency. Alternative is a hand-rolled
   JSON-RPC/stdio server. Recommendation: `rmcp`.
2. **Write-mode in v1, or read-only only?** Recommendation: read-only v1.
3. **Default connection exposure: all, or opt-in per profile-id?**
   Recommendation: opt-in.
