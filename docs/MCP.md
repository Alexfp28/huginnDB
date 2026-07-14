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
