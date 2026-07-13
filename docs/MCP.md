# HuginnDB MCP connector

`huginndb-mcp` is a headless [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the databases HuginnDB already knows about — the profiles in
`profiles.json`, with passwords read from the OS keychain — to an MCP client such
as Claude Code, Claude Desktop, or Cursor. The assistant can then inspect the
*actual* state of your databases (schema, sample rows, row counts, server
version, privileges) instead of guessing.

It is a **separate, read-only process**. It does not share the running desktop
app's open connections; it opens its own pools lazily, on demand, and only for
the connections you explicitly expose.

See [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) for the design
rationale.

## Building

The connector is behind an optional `mcp` cargo feature, so a normal
`pnpm tauri:build` never compiles it. Build it explicitly:

```bash
cd src-tauri
cargo build --release --features mcp --bin huginndb-mcp
# binary at: src-tauri/target/release/huginndb-mcp[.exe]
```

## Configuring a client

Point the client at the built binary and name the profile id(s) to expose.
Example `mcpServers` block (Claude Desktop / Claude Code / Cursor share this
shape):

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

Find a profile id in the desktop app, or read it from `profiles.json` in your
platform config dir (`%APPDATA%\HuginnDB` on Windows,
`~/.config/HuginnDB` on Linux, `~/Library/Application Support/HuginnDB` on
macOS). The `id` is the stable UUID field — not the display `name`.

## Command-line flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--connections <a,b,c>` | *(none)* | Profile ids the server may reach. **Opt-in**: with none set, nothing is exposed. |
| `--max-rows <n>` | `1000` | Upper bound on rows returned by a single `run_query` / `browse_table` call, so a tool call can't dump a whole table into the model's context. |
| `--allow-writes[=true\|false]` | `false` | Reserved. v1 is read-only: `run_query` rejects any non-read-only statement and no write tools are registered. |

Flags accept both `--flag value` and `--flag=value`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_connections` | Which databases this server is allowed to reach. |
| `list_databases` | Databases / schemas / catalogs on a connection. |
| `list_tables` | Tables and views, with approximate row counts and sizes. |
| `describe_table` | Full structure: columns, types, nullability, PK, FKs, indexes. |
| `list_indexes` | Indexes on a table and the columns each covers. |
| `run_query` | Run a single **read-only** SQL statement. |
| `browse_table` | Browse one page of rows without writing SQL. |
| `server_version` | The connected engine and version. |
| `list_users` / `list_privileges` | Server-side users/roles and their grants. |

## Security

- **Read-only.** `run_query` rejects anything that isn't a `SELECT` / `WITH` /
  `SHOW` / `EXPLAIN` / `PRAGMA` statement, and no insert/update/delete tools
  exist in v1.
- **Opt-in exposure.** Only the profile ids you pass to `--connections` are
  reachable; every other tool call for an unknamed connection is refused.
- **No new plaintext.** Passwords are read from the OS keychain at connect time,
  exactly like the desktop app. The connector never logs or persists them.
- **Row cap.** `--max-rows` bounds every result set.

## Supported drivers

PostgreSQL, MySQL, SQLite, and MongoDB — the same drivers as the desktop app,
via the same backend code.
