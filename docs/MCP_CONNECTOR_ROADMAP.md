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
| `describe_table` | `structure::describe_relation_inner` | columns, types, PK, FK, indexes; plus a `view` object when the relation is a view |
| `list_indexes` | `schema::list_indexes_inner` | |
| `run_query` | `execute_query_inner` | rejects non-read-only SQL unless write-mode |
| `browse_table` | `fetch_table_data_inner` | paginated/filtered browse without writing SQL |
| `server_version` | `schema::server_version_inner` | |
| `list_users` / `list_privileges` | `schema::*_inner` | permission context |
| `insert_row` / `update_cell` / `delete_rows` | respective `_inner` | require the connection's write policy ≥ `data` (see Phase 4) |
| `save_view` / `drop_view` | `view::save_any_view_inner` / `view::drop_view_inner` | require the connection's write policy = `full`; a view is schema (see Views, below) |

> As shipped (1.9.0), writes are gated by the per-connection `mcp_write` policy,
> **not** a global `--allow-writes`; DDL goes through `run_query` at the `full`
> tier rather than a dedicated `execute_write` tool. See the Phase 4 section
> above and `docs/MCP.md`.

## Views (shipped after 1.17.0)

Views reached the surface as two write tools — `save_view`, `drop_view` — plus a
`view` object added to `describe_table`'s reply. Three judgements are worth
recording, because each of them is a place where the obvious choice was the
wrong one.

**Reading was unified into `describe_table` rather than given a `get_view`
tool.** `describe_table` already answered for a view — a view has columns, and
it returned them — so what it lacked was the body, not view-awareness. Adding a
sibling tool would have meant two tools whose answers overlap, and an assistant
choosing between them from a `list_tables` row that says only `kind: "view"`.
The cost is one extra indexed catalog lookup per `describe_table` of a plain
table, which is why the view read returns `Option` rather than `NotFound`:
"that is a table" is an answer.

**Dedicated write tools were justified here even though a structure-editor tool
was deferred in Phase 4, and the reason is not "views are more important".** The
Phase 4 argument was about the DTO: making a model synthesise a whole
`TableStructure` — per-column types, nullability, defaults, keys, identity flags,
dozens of fields that must all be right or data is silently destroyed — is worse
than having it emit `ALTER TABLE`. That argument does not transfer, because a
`ViewDefinition` is `{schema, name, query}` and `query` is a `SELECT` the model
is writing anyway. `save_view` is closer in shape to `update_cell` (a value and
an address) than to `apply_structure_change`. Table DDL still reaches the
database only through `run_query`, and that remains the right call.

What the tools buy over `run_query` at `full`, concretely:

| Capability | Reachable through `run_query`? |
| --- | --- |
| MongoDB views, read or write | **No.** `db::mongo::shell` has no DDL vocabulary, so a stored pipeline was unreachable in both directions. This is the largest single gap the tools close. |
| Postgres rename + body change atomically | **No.** One statement per call, no transaction. `execute_all` wraps both. |
| Editing a SQLite view | **Badly.** Two calls, with a window where the view does not exist and no rollback if the `CREATE` fails. |
| Reading the current body to build the diff | **No** portable way — `pg_get_viewdef` vs `information_schema.views` vs `sqlite_master` vs `sys.sql_modules`. |
| Seeing the DDL before running it | **No.** |

**The tier is `full`, and that was forced rather than chosen.** `db::sql::classify`
already sends `CREATE OR REPLACE VIEW` and `DROP VIEW` to `StmtClass::Ddl`, so a
`data` connection is refused them through `run_query`. Had the tools been
`DataWrite`, that same connection would have obtained through a tool precisely
what the policy denies — a privilege escalation introduced by a new tool, not a
finer-grained permission. Two tests assert it so the tempting "a view is just a
stored query" simplification fails a build rather than a review.

One shape decision worth keeping if this is ever extended: preview and apply are
**two bridge variants** even though they carry identical fields and are exposed
as a single tool with a `preview` flag. A shared variant would make
`is_mutating()` and the server's policy check read a *field* to decide
read-vs-DDL, and a later refactor dropping that binding would grant DDL at
`read-only` with nothing failing to compile.

## Client configuration (target UX)

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
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

## Open: could this ship through a marketplace instead of a per-machine install?

Raised after a user observed that installing the connector is a manual,
per-machine step, and that an assistant's permissions look better governed
when they come from the AI app's own per-user settings than from what HuginnDB
has configured.

**First, the premise needs narrowing.** Approval already belongs entirely to
the client: every MCP tool call goes through the client's permission system
(in Claude Code, `allow`/`ask`/`deny` rules plus the auto-mode classifier —
see the "When the client blocks the call, not the connector" section of
`docs/MCP.md`). The per-connection write policy is not a competing permission
model; it is a second, server-side ceiling applied *after* the client has
approved the call, and it is the only one of the two that HuginnDB can
guarantee. So a marketplace does not change *who decides*: it changes
**distribution**. The one exception is genuinely about permissions —
organization controls on claude.ai connectors, where an admin can set a tool
to `ask` or `blocked` centrally and that decision overrides even a user's
allow rules. That exception is also the route we can't take:

| Route | Verdict |
| --- | --- |
| **claude.ai connector directory** | **Not viable.** Connectors are *remote* servers (HTTP/SSE + OAuth). This connector reads `profiles.json` and the OS keychain and opens pools against the user's own host/LAN. Listing it would require a hosted relay — credentials leaving the machine, plus cloud sync of profiles, both explicitly out of scope. |
| **Claude Code plugin marketplace** | **Viable today.** A plugin is a git repo with `.claude-plugin/plugin.json` and a root `.mcp.json`, which supports `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` and a `bin/` directory placed on the Bash `PATH`. Anthropic runs a reviewed community marketplace (`anthropics/claude-plugins-community`) with a submission form and a `claude plugin validate` check. Install becomes `/plugin marketplace add Alexfp28/huginnDB` + `/plugin install`, with no hand-edited JSON. |
| **Claude Desktop extension (`.mcpb`)** | **Viable**, and the closest thing to a marketplace for *local* servers: a zip + `manifest.json`, one-click install from Settings → Extensions with a per-extension toggle. Whether Anthropic accepts `.mcpb` submissions into a curated directory (as opposed to sideloading) is unconfirmed — check the current `claude.com/docs/connectors/custom/desktop-extensions`. |

Neither viable route can bundle the binary: `huginndb-mcp` is a compiled
per-target sidecar shipped by the app's own installer (gotcha #22), and
committing four target triples into a plugin repo is not an option. Both would
need a small launcher that resolves the *installed* sidecar — the same
`current_exe()`-relative logic `get_mcp_connector_info` already implements,
plus a `HUGINNDB_MCP_PATH` escape hatch.

Two prerequisites worth doing on their own merits, whichever route is picked:

1. **Move `--connections` out of argv.** The exposed profile list currently
   lives in the client's config, so changing *which* connections are reachable
   means editing that config and restarting the client — while the write
   policy, the more security-relevant half, is already re-read from disk on
   every write attempt. If the sidecar read the list from HuginnDB's own state
   (a file written by Settings → MCP, with argv still winning when passed),
   the client-side command collapses to a bare `huginndb-mcp`. That is exactly
   what a plugin or `.mcpb` needs in order to be a single artifact that works
   for everyone, and it moves exposure control into the app that owns the
   profiles.
2. **Declare `_meta["anthropic/requiresUserInteraction"] = true` on the write
   tools.** This is available now, with no marketplace involved: it forces an
   explicit approval prompt on every call, even in auto mode and even when an
   allow rule matches (Claude Code v2.1.199+; older and other clients ignore
   it). `rmcp` 2.2 already models it (`Tool::meta` / `with_meta`), so the
   change is confined to the router setup in `src-tauri/src/mcp/mod.rs`. It
   delivers the "the user approves it in the app" property directly, without
   giving up the write policy — and it needs a decision on scope: always on
   for `insert_row`/`update_cell`/`delete_rows`, and for `run_query` only when
   some exposed connection is above `read-only`.
