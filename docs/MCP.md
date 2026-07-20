# HuginnDB MCP connector

`huginndb-mcp` is a headless [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the databases HuginnDB already knows about — the profiles in
`profiles.json`, with passwords read from the OS keychain — to an MCP client such
as Claude Code, Claude Desktop, Cursor, Antigravity, or Codex. The assistant can
then inspect the *actual* state of your databases (schema, sample rows, row
counts, server version, privileges) instead of guessing.

Because it's a standard stdio MCP server with no client-specific code, **any**
spec-compliant MCP client can drive it — the sections below cover the ones
with their own config quirks worth documenting; anything else that speaks MCP
(an editor's built-in agent, a custom harness, …) works the same way once you
point it at the binary.

It is a **separate process**. It does not share the running desktop app's open
connections; it opens its own pools lazily, on demand, and only for the
connections you explicitly expose. Each exposed connection has a **write
policy** — `read-only` (the default), `data`, or `full` — set per connection in
**Settings → MCP**; reads always work, and writes only succeed when that
connection's policy allows them. See [Security](#security).

See [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) for the design
rationale.

## Getting the binary

**Packaged installs (the normal case):** `huginndb-mcp` ships as a Tauri
sidecar, installed right next to the main executable — nothing to build.
Open **Settings → MCP** in the app: it shows the resolved path, lets you pick
which saved connections to expose, and generates ready-to-paste config for
Claude Code / Claude Desktop / other clients. The rest of this doc is the
reference for what that panel gives you, plus clients it doesn't generate a
snippet for (Codex).

**Building from source (development only):** the connector lives in its own
workspace crate (`src-tauri/mcp-server/`), kept out of the desktop app's own
`Cargo.toml` so a normal `pnpm tauri:build` never compiles or bundles it on
its own (see the tauri-bundler multi-`[[bin]]` gotcha in `CLAUDE.md` for why;
the release workflow stages it separately as the sidecar). Build it
explicitly:

```bash
cd src-tauri
cargo build --release -p huginndb-mcp
# binary at: src-tauri/target/release/huginndb-mcp[.exe]
```

## Configuring a client

Every client points at the connector's **absolute path** — get it from
Settings → MCP in a packaged install, or see [Getting the
binary](#getting-the-binary) for a source build (on Windows,
`…\target\release\huginndb-mcp.exe`).

Wherever a snippet says `<profile-id>`, use the stable UUID `id` of the
connection you want to expose. Find it in the desktop app, or read it from
`profiles.json` in your platform config dir (`%APPDATA%\HuginnDB` on Windows,
`~/.config/HuginnDB` on Linux, `~/Library/Application Support/HuginnDB` on
macOS) — it's the `id` field, not the display `name`. Expose several at once
with a comma-separated list (`--connections id1,id2`).

### Claude Code (CLI)

```bash
claude mcp add huginndb -s user -- /absolute/path/to/huginndb-mcp --connections <profile-id>
```

- The `--` separates the server's command+args from `claude`'s own flags.
- `-s user` makes it available in every project; use `-s local` (the default)
  for just the current repo.
- Check it with `/mcp` inside a session, then try *"with huginndb, list the
  tables in `<name>` and show me 5 rows of the first one"*.

Equivalent hand-written config (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

### Claude Desktop

Settings → Developer → **Edit Config** opens `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on
macOS). Add the server and **restart the app**:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "C:\\path\\to\\huginndb-mcp.exe",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

On Windows, double the backslashes in the JSON path (`\\`).

### Cursor

Cursor reads MCP servers from a `mcp.json` with the same `mcpServers` shape as
Claude Desktop — either `.cursor/mcp.json` in a project root (scoped to that
project) or `~/.cursor/mcp.json` (global, every project):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

You can also add it from Cursor's Settings → MCP UI ("Add new global MCP
server") if you'd rather not hand-edit the file. Either way, the JSON snippet
Settings → MCP generates in the app pastes in as-is.

### Antigravity (Google)

Antigravity — Google's Gemini-powered agentic IDE — uses the same
`mcpServers`/`command`/`args` shape. Rather than hunting for the config file
(its location has moved between Antigravity releases), add the server from
the UI: **Agent panel → "…" menu → MCP Servers → Manage MCP Servers → View
raw config**, then paste:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

Save and hit refresh in the Installed MCP Servers list. (Antigravity's one
real divergence from Cursor/Claude Desktop is remote HTTP servers, which use
`serverUrl` instead of `command`/`args` — doesn't apply here, since
`huginndb-mcp` is a local stdio process.)

### Codex CLI

Codex reads MCP servers from `~/.codex/config.toml` (TOML — not Claude's JSON).
Add a `[mcp_servers.<name>]` table:

```toml
[mcp_servers.huginndb]
command = "C:\\path\\to\\huginndb-mcp.exe"
args = ["--connections", "<profile-id>"]
# optional: startup_timeout_sec = 20
```

Or add it from the CLI (stdio servers take a `--`-separated command):

```bash
codex mcp add huginndb -- /absolute/path/to/huginndb-mcp --connections <profile-id>
```

The tools then show up under the `huginndb` server inside Codex.

## Command-line flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--connections <a,b,c>` | *(none)* | Profile ids the server may reach. **Opt-in**: with none set, nothing is exposed. |
| `--max-rows <n>` | `1000` | Upper bound on rows returned by a single `run_query` / `browse_table` call, so a tool call can't dump a whole table into the model's context. |
| `--read-only[=true\|false]` | `false` | Global kill-switch: force **every** connection to read-only regardless of its saved write policy. A quick way to expose the connector in a guaranteed-safe mode without touching any profile. |
| `--allow-writes` | — | **Deprecated and ignored.** Writes are now governed per connection by the write policy set in Settings → MCP (see [Security](#security)); this flag no longer grants anything and only prints a one-time deprecation notice. |

Flags accept both `--flag value` and `--flag=value`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_connections` | Which databases this server is allowed to reach. |
| `list_databases` | Databases / schemas / catalogs on a connection. |
| `list_tables` | Tables and views, with approximate row counts and sizes. |
| `describe_table` | Full structure: columns, types, nullability, PK, FKs, indexes. |
| `list_indexes` | Indexes on a table and the columns each covers. |
| `run_query` | Run a single statement (SQL for Postgres/MySQL/SQLite, mongosh-style for MongoDB). Reads always work; writes require the connection's write policy to allow them (`data` for DML, `full` for DDL). |
| `browse_table` | Browse one page of rows without writing SQL. |
| `server_version` | The connected engine and version. |
| `list_users` / `list_privileges` | Server-side users/roles and their grants. |
| `insert_row` *(write)* | Insert one row (values as text; database defaults for omitted columns). Requires `data` or `full`. |
| `update_cell` *(write)* | Update one column of the single row addressed by its full primary key. Requires `data` or `full`. |
| `delete_rows` *(write)* | Delete one or more rows, each addressed by its full primary key. Requires `data` or `full`. |

`list_connections` reports each connection's effective write policy so the
assistant knows up front what it may do.

## MongoDB: targeting a database on a multi-database connection

A MongoDB connection with no default database (`list_connections`'
`database: ""` — the URI has no `/dbname`) can't run any table-scoped tool
until it knows which database to use, since there's nothing equivalent to a
SQL catalog to fall back to. Pass the database name via:

- `schema` on `list_tables`, `describe_table`, `list_indexes`, and
  `browse_table`.
- `database` on `run_query` (its bare `sql` has no field for this).

The server resolves this the same way the desktop app's schema explorer does
when you expand a database — reusing the same MongoDB client and re-tagging
it, no new connection or re-authentication — and caches it, so repeated calls
for the same database on the same connection are cheap. A single-database
connection (one with `/dbname` already in its URI) ignores these — they're
only needed when `list_connections` shows an empty `database`.

## Security

- **Writes gated per connection.** Every exposed connection has a write policy,
  set in **Settings → MCP** and saved in `profiles.json`:
  - **`read-only`** (default) — only reads succeed. `run_query` accepts
    `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` (SQL) or
    `find`/`aggregate`/`countDocuments`/`distinct` (MongoDB), classified with
    the same operation classifier the desktop query editor uses — not a
    plain-SQL keyword match, so mongosh reads aren't mistaken for writes. Every
    write tool is refused.
  - **`data`** — adds row-level DML: `INSERT`/`UPDATE`/`DELETE` through
    `run_query`, plus the `insert_row` / `update_cell` / `delete_rows` tools.
    No schema changes.
  - **`full`** — adds DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) through
    `run_query`.

  The policy is re-read from disk on **every write attempt**, so changing a
  connection's level in the app takes effect without restarting the AI client.
- **Approval stays with the client.** The connector is a headless process your
  MCP client spawns; it can't show a prompt. The per-action "allow this tool?"
  approval is the client's job (Claude Code / Desktop / Cursor all ask). The
  connector's role is *policy* (what's allowed) plus *audit*.
- **Audit log.** Every write (success or failure) appends a line to
  `mcp-audit.log`, in the same config directory as `profiles.json`. Reads are
  not logged, so the file is a clean record of state-changing operations.
- **Whole-table guard.** A `run_query` `UPDATE`/`DELETE` with no `WHERE` clause
  is refused outright, at any level — add an explicit predicate (`WHERE 1=1` if
  you truly mean every row).
- **Global kill-switch.** `--read-only` forces every connection to read-only
  regardless of its saved policy.
- **Opt-in exposure.** Only the profile ids you pass to `--connections` are
  reachable; every other tool call for an unnamed connection is refused.
- **No new plaintext.** Passwords are read from the OS keychain at connect time,
  exactly like the desktop app. The connector never logs or persists them (the
  audit log records statements and row counts, never credentials).
- **Row cap.** `--max-rows` bounds every result set.

## Supported drivers

PostgreSQL, MySQL, SQLite, and MongoDB — the same drivers as the desktop app,
via the same backend code.
