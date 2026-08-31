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

It is a **separate process**. By default it opens its own pools lazily, on
demand, and only for the connections you explicitly expose — it does not share
the running desktop app's. It *can*, if you turn on **Settings → Connections →
Share pools with the MCP connector**, which gives the whole machine a single
connection budget per server; see [Sharing the app's
pools](#sharing-the-apps-pools). Each exposed connection has a **write
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
| `--max-connections <n>` | `2` | Budget per **server**, within this process. See [Connection footprint](#connection-footprint) — the default is deliberately well below the desktop app's. A connection that pins its own limit in HuginnDB still wins when it is the stricter of the two. |
| `--read-only[=true\|false]` | `false` | Global kill-switch: force **every** connection to read-only regardless of its saved write policy. A quick way to expose the connector in a guaranteed-safe mode without touching any profile. |
| `--allow-writes` | — | **Deprecated and ignored.** Writes are now governed per connection by the write policy set in Settings → MCP (see [Security](#security)); this flag no longer grants anything and only prints a one-time deprecation notice. |

Flags accept both `--flag value` and `--flag=value`.

## Connection footprint

The connector is a **separate process** from the HuginnDB desktop app, with its
own connection pools. It does not share the app's. That has a consequence worth
knowing before you point it at a database somebody else is also using:

- Every MCP client that has `huginndb-mcp` configured spawns **its own copy**.
  Claude Code and Claude Desktop configured against the same profile means two
  processes, each with its own pool.
- Those pools are additional to the desktop app's, to your IDE's data source,
  and to any application backend pointing at the same server. They all count
  against the same server-side `max_connections`.

Two defaults keep that bounded:

- **`--max-connections` defaults to `2`** per exposed connection, rather than
  the desktop app's `5`. MCP is request/response over stdio and tools are
  dispatched one at a time, so a bigger pool buys nothing here. It is also a
  *per-server* budget within this process: two exposed connections pointing at
  the same host share it rather than getting one each.
- **Idle pools are closed after 5 minutes** with no tool call. The connector is
  long-lived but its work is bursty; a pool opened for one question is not held
  for the rest of the week. It reopens transparently on the next call.

### Sharing the app's pools

If the desktop app is running, it can serve the connector's queries out of its
*own* pools instead — turn on **Settings → Connections → Share pools with the
MCP connector**. Then:

- The whole machine has one budget per server. The app owns every connection;
  the connector (and every other connector, one per MCP client) opens none.
- The connector's activity shows up in the app's **Console** live — every
  browse, query and write, as it happens — instead of only in `mcp-audit.log`
  after the fact. Writes are still audited to that file too.
- The write policy is re-checked by the app, independently of the connector's
  own check.

It is **off by default**, because it opens a listener (loopback only,
token-protected) that fronts every database you have saved. When the app isn't
running — or the setting is off — the connector opens its own pools exactly as
described above, and says so on stderr if it loses the app mid-session.

If a server is still tight, set a per-connection ceiling in HuginnDB
(Settings → Connections, or the connection's own **Max connections** field).
It is stored in `profiles.json`, which this connector reads, so it applies to
the sidecar with no extra configuration. Settings → Connections also shows how
many pools the desktop app is holding right now, and can release the
per-database ones on demand.

## Tools

| Tool | What it does |
| --- | --- |
| `list_connections` | Which databases this server is allowed to reach. |
| `list_databases` | Databases / schemas / catalogs on a connection. |
| `list_tables` | Tables and views, with approximate row counts and sizes. |
| `describe_table` | Full structure: columns, types, nullability, PK, FKs, indexes. Works on a view too, and adds a `view` object with the view's definition when the relation is one — `query` (the SELECT body) on SQL, `viewOn` + `pipeline` on MongoDB. |
| `list_indexes` | Indexes on a table and the columns each covers. On MongoDB each entry also carries a `mongo` object with the full definition — per-key direction and type, `sparse`, TTL, partial filter, collation, weights, size and usage. Read it before recreating an index: the column list alone cannot tell `{createdAt: -1}` from `{createdAt: 1}`. |
| `run_query` | Run a single statement (SQL for Postgres/MySQL/SQLite/SQL Server, mongosh-style for MongoDB). Reads always work; writes require the connection's write policy to allow them (`data` for DML, `full` for DDL). |
| `browse_table` | Browse one page of rows without writing SQL. |
| `server_version` | The connected engine and version. |
| `list_users` / `list_privileges` | Server-side users/roles and their grants. |
| `pulse_health` | Live vital signs — queries/s, connection pressure, cache hit rate — normalised to one metric catalogue regardless of engine. MySQL and MongoDB only. |
| `pulse_metrics` | One metric's stored history from Pulse's on-disk sampler, oldest first. Empty unless the connection has Pulse's history sampler turned on in Settings. |
| `pulse_top_queries` | Statements the server has spent the most time on, each carrying a runnable `sample` when one is available. |
| `pulse_explain` | The plan the server would use for one statement — typically a `pulse_top_queries` row's own `sample` — without running it. Refuses anything that isn't read-only, single-statement, and not itself `EXPLAIN`/`ANALYZE`. |
| `pulse_storage` | The connection's biggest relations, largest first, split into data / index / free space. |
| `pulse_sessions` | Every session or operation currently open on the server, with a best-effort blocking chain on MySQL. |
| `pulse_index_usage` | Index usage across the biggest relations, least-read first — the fastest way to spot an index nobody reads. |
| `insert_row` *(write)* | Insert one row (values as text; database defaults for omitted columns). Requires `data` or `full`. |
| `update_cell` *(write)* | Update one column of the single row addressed by its full primary key. Requires `data` or `full`. |
| `delete_rows` *(write)* | Delete one or more rows, each addressed by its full primary key. Requires `data` or `full`. |
| `save_view` *(write)* | Create a view, redefine an existing one, or rename one. Pass just `name` and `query` — it reads the current definition itself to work out which. `preview: true` returns the statements without running them, and is a read. Requires `full`. |
| `drop_view` *(write)* | Drop a view. Refuses anything that isn't one. Requires `full`. |
| `create_index` *(write)* | **MongoDB only.** Create one index. `keys` is source text (`{createdAt: -1}`, `{location: "2dsphere"}`), plus the usual options — unique, sparse, hidden, TTL, partial filter, collation, text weights, and an `extraOptions` escape hatch. Requires `full`. |
| `drop_index` *(write)* | **MongoDB only.** Drop one index by name. `_id_` is refused. Requires `full`. |

`list_connections` reports each connection's effective write policy so the
assistant knows up front what it may do.

### Indexes: why the two write tools are MongoDB-only

On the SQL drivers an index is created with `CREATE INDEX`, which `run_query`
reaches at `full` and which is strictly more expressive than any portable form —
`USING gin`, `INCLUDE`, a partial predicate, an expression index. A tool would
have to flatten all of that into a fixed set of fields, and HuginnDB's own
SQL-side index vocabulary is deliberately narrow (name, columns, unique) because
it exists to be *diffed* by the structure editor, not to describe every index a
server can build. Exposing that as a tool would be a downgrade.

MongoDB is the opposite case: until 1.19.0 the mongosh grammar had no
`createIndex` at all, so the operation was not reachable *by any route*. Both
routes exist now — the two tools, and `db.coll.createIndex(...)` through
`run_query` — and they share one implementation.

There is no "edit an index" tool because MongoDB cannot alter one in place: a
replacement is `drop_index` then `create_index`, and leaving it as two calls
keeps the window where the index is missing visible to the caller. Hiding an
index (`collMod`) is reachable through `run_query` as
`db.coll.hideIndex("name")` — the reversible way to rehearse a drop.

### Pulse: how `pulse_metrics` reaches the sampler's history

`pulse_metrics` reads `pulse.db` — the SQLite file HuginnDB's own background
sampler writes a tick to every 60 seconds for each connection with Pulse's
history sampler turned on (Settings → Pulse). Reaching it needs no special
handling for either way this connector runs:

- **With the desktop app's bridge active**, this tool (like every other one)
  is served by the app, so it reads the app's own `pulse.db` handle directly.
- **In standalone sidecar mode**, the connector opens the *same* file at the
  same path — `pulse.db` lives next to `profiles.json` in the platform config
  dir, resolved identically by both processes — and only ever runs a `SELECT`
  against it. It never runs the sampler itself (that loop only starts inside
  the desktop app's own launch sequence), so there is no write path to guard
  against; SQLite's WAL journal mode, which this file always uses, already
  allows any number of concurrent readers alongside the app's one writer.

Either way, an empty reply means Pulse's sampler has never run for that
connection — turn it on in Settings, wait for a tick or two, and ask again.

## MongoDB: targeting a database on a multi-database connection

A MongoDB connection with no default database (`list_connections`'
`database: ""` — the URI has no `/dbname`) can't run any table-scoped tool
until it knows which database to use, since there's nothing equivalent to a
SQL catalog to fall back to. Pass the database name via:

- `schema` on `list_tables`, `describe_table`, `list_indexes`,
  `browse_table`, `save_view` and `drop_view`.
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
    `run_query`, plus the `save_view` / `drop_view` / `create_index` /
    `drop_index` tools. On MongoDB this is also the tier for
    `createIndex`/`dropIndex`/`hideIndex`, `drop()` and `renameCollection`
    through `run_query`.

  An index and a namespace are schema too, for the same reason and with the
  same consequence: `create_index` and `drop_index` sit at `full`, and so does
  every MongoDB statement that touches an index or a collection's existence.

  A view is schema, which puts managing one at `full` rather than `data`. That
  reads oddly for a second — dropping a *view* needs `full` while deleting
  *rows* only needs `data` — and it is the same asymmetry `DROP TABLE` and
  `DELETE FROM` already have. It is also the only consistent answer: the
  `CREATE OR REPLACE VIEW` you could write by hand through `run_query` is
  classified as DDL, so a `data` connection is refused it, and a tool that
  allowed the same change anyway would hand back what the policy just denied.
  `save_view`'s `preview: true` is a genuine exception rather than a loophole:
  it builds the statements and runs nothing, so it is classified as a read and
  works at any level.

  The policy is re-read from disk on **every write attempt**, so changing a
  connection's level in the app takes effect without restarting the AI client.
- **Approval stays with the client.** The connector is a headless process your
  MCP client spawns; it can't show a prompt. The per-action "allow this tool?"
  approval is the client's job (Claude Code / Desktop / Cursor all ask). The
  connector's role is *policy* (what's allowed) plus *audit*. The two gates are
  independent, and a write policy of `full` is a *ceiling*, not an instruction
  to the client — see [When the client blocks the call, not the
  connector](#when-the-client-blocks-the-call-not-the-connector).
- **Audit log.** Every write (success or failure) appends a line to
  `mcp-audit.log`, in the same config directory as `profiles.json`. Reads are
  not logged, so the file is a clean record of state-changing operations.
- **Whole-relation guard.** A `run_query` `UPDATE`/`DELETE` with no `WHERE`
  clause is refused outright, at any level — add an explicit predicate
  (`WHERE 1=1` if you truly mean every row). MongoDB is covered by the same
  guard: `updateMany({})` and `deleteMany({})` are refused, and the way to say
  you mean it is a predicate that is trivially true, e.g.
  `deleteMany({_id: {$exists: true}})`. `drop()` is not covered — it is
  unambiguous about its scope and already behind `full`, exactly like
  `DROP TABLE`.
- **Global kill-switch.** `--read-only` forces every connection to read-only
  regardless of its saved policy.
- **Opt-in exposure.** Only the profile ids you pass to `--connections` are
  reachable; every other tool call for an unnamed connection is refused.
- **No new plaintext.** Passwords are read from the OS keychain at connect time,
  exactly like the desktop app. The connector never logs or persists them (the
  audit log records statements and row counts, never credentials).
- **Row cap.** `--max-rows` bounds every result set.

### When the client blocks the call, not the connector

A write can be refused by *either* gate, and they answer to different owners.
The symptom that trips people up: a connection set to `full` in Settings → MCP,
and the AI assistant still reports it can't run a `CREATE`/`ALTER`/`DROP`.

Telling them apart takes a second:

| | Refused by the connector | Blocked by the client |
| --- | --- | --- |
| What you see | A tool *result* naming the level: *"connection … has MCP write policy "read-only", which does not permit this operation (needs at least "full")"* | The client's own denial. In Claude Code's auto mode the reason is usually the fixed text `Blocked by classifier` |
| `mcp-audit.log` | A line was appended (refusals are logged too) | **Nothing** — the call never reached the connector |
| Who changes it | You, in HuginnDB → Settings → MCP | Whoever runs the AI client, in *their* client config |

Claude Code specifically: in [auto mode](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)
a second model — the classifier — reviews each action instead of prompting the
user, and MCP tool calls go through it. Its default block list includes
*"production deploys and migrations"* and *"modifying shared infrastructure"*,
and until you name concrete targets it treats any host or namespace whose name
carries `prod` as a sensitive remote target. Schema DDL against a live database
server reads as exactly that, whatever HuginnDB's own policy says — and the
classifier has no way to know the server is a disposable test instance unless
someone tells it.

The fixes all live on the client side, and all of them are the human's call to
make — the connector cannot and should not try to influence them:

- **One-off:** open `/permissions` → **Recently denied**, press `r` on the
  entry to retry it with a manual approval.
- **Be specific in the request.** Explicit user intent clears the classifier's
  soft blocks; a general one doesn't. *"tidy up the schema"* won't authorise a
  DDL, *"run this `ALTER TABLE` on the `sandbox` database"* does.
- **Pre-approve the tool** with an [allow
  rule](https://code.claude.com/docs/en/permissions#permission-rule-syntax) in
  `~/.claude/settings.json`, which resolves *before* the classifier runs. The
  server segment has to be literal — an unanchored glob is ignored:

  ```json
  {
    "permissions": {
      "allow": ["mcp__huginndb__run_query"]
    }
  }
  ```

- **Give the classifier context** about the database with
  [`autoMode`](https://code.claude.com/docs/en/auto-mode-config) entries (user
  or managed settings only — the classifier deliberately ignores a repo's
  `.claude/settings.json`). Keep `"$defaults"` or you replace the built-in
  rules wholesale:

  ```json
  {
    "autoMode": {
      "environment": ["$defaults", "Key internal services: the `sandbox` SQL Server instance at db-test.example.internal is a disposable test database, restored nightly from a fixture"],
      "allow": ["$defaults", "Schema changes on the `sandbox` database through the huginndb MCP connector are allowed: it holds no production data"]
    }
  }
  ```

- **Or leave auto mode** (Shift+Tab → Manual) and approve each call yourself.

None of this loosens the connector: its own policy is re-read from disk on
every write attempt and applies *after* the client has approved the call, so a
connection left at `read-only` stays read-only no matter how permissive the
client's config is. That asymmetry is the point — the client gates *this
assistant on this machine*, the write policy gates *the database*.

## Supported drivers

PostgreSQL, MySQL, SQLite, MongoDB, and Microsoft SQL Server — the same
drivers as the desktop app, via the same backend code.

The read tools work identically across all of them, and so do the row-level
write tools (`insert_row`, `update_cell`, `delete_rows`).

The one gap is `save_view` on SQL Server, whose T-SQL view DDL builder is not
written yet — it returns an "unsupported driver" error there. Everything else
about views works on all five: `describe_table` reports a view's definition on
every driver, and `drop_view` works on every driver.

`create_index` and `drop_index` are MongoDB-only and return an "unsupported
driver" error elsewhere; `list_indexes` reads on all five. See [Indexes: why the
two write tools are MongoDB-only](#indexes-why-the-two-write-tools-are-mongodb-only).

There is no tool for editing a *table's* structure on any driver. That was
deferred deliberately (see
[`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md)): making an assistant
synthesise a whole column list, with types, nullability, defaults and keys, is
worse than having it emit `ALTER TABLE` through `run_query`, which `full`
allows. That argument is about the *size of the DTO*, which is why it did not
carry over to indexes on MongoDB: an index spec is a key document plus a handful
of flags, closer in shape to `save_view` than to a table.
