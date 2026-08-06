# Connection & pool management — analysis and proposed architecture

Status: **analysis only**, no code changed. Written against `1.12.1`
(`3e1c0a1`).

Motivation: several users report `FATAL: sorry, too many connections already`
(Postgres) / `ER_CON_COUNT_ERROR` (MySQL) on servers they share with other
tooling — typically a JetBrains IDE data source *plus* an application backend
with its own HikariCP pool *plus* the `huginndb-mcp` sidecar under one or more
MCP clients *plus* the HuginnDB desktop app itself, all authenticating as the
same database user against the same endpoint.

The honest framing: HuginnDB is usually **not** the largest consumer in that
picture — a Spring backend's default Hikari pool is 10 connections and an
IntelliJ data source keeps a handful. But HuginnDB is currently the *least
predictable* consumer: its footprint is unbounded, invisible to the user, and
multiplied across processes it doesn't coordinate with. It is very often the
marginal straw, and it is the only one of those consumers we control.

This document maps what the engine does today, quantifies the worst case,
and proposes a target architecture.

---

## 1. How it works today

### 1.1 The pool

`src-tauri/src/db/pool.rs` is the only place a SQL pool is constructed:

```rust
const MAX_CONNECTIONS_SERVER: u32 = 5;   // pool.rs:26
const MAX_CONNECTIONS_SQLITE: u32 = 1;   // pool.rs:30
```

`open_pool` (`pool.rs:117`) builds `PgPoolOptions` / `MySqlPoolOptions` /
`SqlitePoolOptions` with **only** `max_connections` set. Nothing else is
configured, anywhere in the repo — verified by grep: there is no
`min_connections`, `idle_timeout`, `max_lifetime`, `acquire_timeout`,
`test_before_acquire` or `after_connect` call in the tree. Everything else is
whatever `sqlx` 0.8 defaults to (`min_connections` 0, `idle_timeout` 10 min,
`max_lifetime` 30 min, `acquire_timeout` 30 s, `test_before_acquire` true).

Those defaults are *reasonable*. The problem is that they are implicit,
undocumented, and — critically — that `max_connections` is a **per-pool**
number in a system that creates a lot of pools.

MongoDB (`src-tauri/src/db/mongo/mod.rs:43`) sets `server_selection_timeout`
and `app_name` and **nothing about pool size**. The `mongodb` 3.x default is
`maxPoolSize = 100` **per host**, so a three-node replica set is a ceiling of
300 application sockets plus the driver's own monitoring connections — a 20×
divergence from the SQL drivers' 5, entirely by omission.

### 1.2 The unit of accounting is a profile, not a server

`ActiveConnections` (`src-tauri/src/state.rs:302`) is
`HashMap<String, ActivePool>` keyed by **profile id**. Nothing in the backend
knows or asks "how many sockets do I currently hold against `host:port`".

Two consequences:

- Three saved profiles pointing at the same server (a very common setup: same
  host, different default database or different user) are three independent
  pools with three independent budgets of 5.
- `connect`'s idempotency guard (`commands/connection.rs:314`) dedupes by
  profile id only. It correctly prevents a second window from tearing down the
  first window's pool, but it cannot dedupe two *profiles* that resolve to the
  same endpoint.

### 1.3 Per-database child pools multiply the budget

For a multi-database connection (empty `database` field), every database the
user touches spawns a **whole extra pool**:

`open_database_view` (`commands/connection.rs:541`) clones the parent profile,
substitutes `database`, calls `open_pool` again — another `max_connections: 5`
— and registers it under `<parent>::db::<name>`. This is the mechanism that
lets every downstream command keep a single `connection_id` argument, which is
a good design; the cost is that pools scale with *databases browsed*, not with
*servers connected*.

MongoDB is exempt: `resolve_mongo_database_view` (`connection.rs:498`) clones
the parent's `Client` and only re-tags the target database. That is exactly the
right shape — the SQL drivers should converge on it as far as the wire protocol
allows (see §4).

**Child pools are never released.** The only removal paths are:

- `disconnect` (`connection.rs:436`), which sweeps `<id>::db::` children when
  the *parent* goes away;
- `drop_database` (`commands/schema.rs:237`), which closes exactly the one
  child whose database is being dropped.

There is no TTL, no LRU, no cap on how many children a parent may accumulate.
A child opened by a single search keystroke at 09:00 is still registered at
18:00.

### 1.4 Three call sites fan out across every database

1. **Cross-database search** — `SchemaExplorer.tsx:902-926`. Once the debounced
   needle reaches 2 characters and no database is "active", the effect loops
   over *every* visible database and fires `openDatabaseView` + `list_tables`
   **concurrently, unbounded**. On a server with 19 databases that is 19
   simultaneous connection attempts from a single keystroke. There is a
   dedupe-by-in-flight guard, but no concurrency limiter.
2. **Multi-database export** — `ExportDatabaseDialog.tsx:128` and `:192`. One
   `openTrackedDatabaseView` per checked database. Sequential (awaited in a
   `for`), so no burst, but each pool it opens is permanent.
3. **SQL import** — `ImportSqlDialog.tsx:77`, same shape.

The comment at `SchemaExplorer.tsx:886` records that the *eager* warm on
connect was removed for being slow. The search fan-out reintroduced the same
cost, on a trigger the user doesn't associate with opening connections.

### 1.5 The keepalive pins one backend per connection, forever

`keepalive.rs:38` pings every **180 s**. `sqlx`'s default `idle_timeout` is
**600 s**. Because the ping acquires a pooled connection, the heartbeat
guarantees that at least one physical connection per top-level pool is never
idle long enough to be reaped — for the entire life of the app.

With `reconnect_on_launch` enabled (`prefs.rs:112`) and six previously-active
connections, HuginnDB holds six backends permanently from the moment it boots,
before the user runs a single query.

The heartbeat exists for a real reason (NAT/LB idle drops, SSH channel
liveness, and detecting the drops it can't prevent). But it is applied
uniformly to every connection, including plain LAN Postgres connections that
never needed it.

### 1.6 Teardown is by `Drop`, not by an awaited close

`disconnect` is a **synchronous** command that removes the `ActivePool` from
the map and lets `Drop` do the rest. `sqlx` cannot perform a graceful
close from a `Drop` impl; the codebase already knows this — see the comment at
`commands/schema.rs:229-235`, where `drop_database` explicitly does
`p.close().await` because "`Pool::close().await` waits for those connections to
actually go away rather than relying on the lazy drop of the `ActivePool`".

That reasoning applies to every disconnect, not just the drop-database case.
It matters most in exactly the burst scenarios:

- **Environment switching** (`stores/session/environments.ts`, `switchTo`)
  disconnects every pool and then immediately reconnects the incoming
  environment's set. For a moment you can hold both.
- **Reconnect after a lost connection** (`ConnectionsTree.tsx:182`) does
  `disconnect` → `connect` back to back.
- **App exit**: there is no `RunEvent::ExitRequested` / window-close hook in
  `lib.rs` that closes pools. Process exit closes the sockets, so the server
  does reap them — but not gracefully, and not at all promptly when an SSH
  tunnel or a connection pooler sits in the middle.

### 1.7 The MCP sidecar is a second, uncoordinated client

`huginndb-mcp` is a **separate OS process** with its **own** `AppState` and its
**own** `ActiveConnections` map (`mcp/mod.rs:452`, `ensure_connected`). It:

- opens pools through the same `open_pool`, therefore with the same
  `max_connections: 5` per exposed profile;
- **never removes a pool** — grep confirms `connections.write()` in
  `mcp/mod.rs` only ever calls `insert`. Pools live as long as the process,
  and the process lives as long as the MCP client keeps it (days);
- cannot see the desktop app's pools, and the desktop app cannot see its.

One user running Claude Code *and* Claude Desktop against the same profile has
**two** sidecar processes, each with its own budget of 5, on top of the GUI's.
Nothing in the product surfaces this. `docs/MCP.md` documents the write policy
in detail and says nothing about connection cost.

The one mitigating factor: sidecar pools get `_keepalive: None`, so `sqlx`'s
10-minute `idle_timeout` does reap their physical connections down to
`min_connections: 0` between tool calls. The pool object survives and
re-expands on the next call, but an idle sidecar is not holding sockets. This
is the correct behaviour and should be preserved.

### 1.8 `too many connections` gets no special treatment

`AppError` has no classifier for it. The driver's raw string goes to a
`toast.error` (`lib/connection/connectFlow.ts:37`). Concretely:

- The user sees a message that names the *server's* limit and gives no hint
  that HuginnDB itself is holding 14 pools.
- Nothing throttles. The search fan-out at `SchemaExplorer.tsx:902` will re-fire
  every failed `openDatabaseView` on the next keystroke, hammering a server
  that is already refusing connections.
- There is no "close idle pools and retry" affordance because there is no
  concept of an idle pool.

### 1.9 No user-facing control or visibility

`prefs.rs` has ~30 preferences covering editor, grid and UI. **Not one is about
connections.** There is no per-profile override either — `ConnectionProfile`
(`state.rs:100`) carries `ssl`, `ssh_tunnel`, `visible_databases`,
`mcp_write`… but no pool sizing. A user who knows their shared staging box
tolerates three sessions has no way to say so.

There is also no way to *see* what is open. The Console logs connect/disconnect
events, but there is no live view of pools, their in-use/idle counts, or when
each was last used — even though `ActiveConnections` holds everything needed
and `sqlx` exposes `Pool::size()` / `Pool::num_idle()`.

### 1.10 Incidental: `pool_for` is duplicated seven times

`commands/{query,schema,dump,view,structure,bulk,mongo}.rs` each define a
private `fn pool_for(state, id)`. They are the natural single interception
point for last-used tracking, per-endpoint accounting and lazy re-open — and
right now there are seven of them to keep in sync.

---

## 2. Worst-case arithmetic

One developer, one Postgres server with 12 databases, default
`max_connections = 100` (minus `superuser_reserved_connections = 3`).

| Consumer | Connections |
| --- | --- |
| HuginnDB GUI — parent pool | up to 5 |
| HuginnDB GUI — 12 child pools after one cross-database search | up to 60 |
| `huginndb-mcp` under Claude Code | up to 5 per exposed profile |
| `huginndb-mcp` under Claude Desktop | up to 5 per exposed profile |
| IntelliJ data source | ~1–3 idle, more while querying |
| Their Spring backend (HikariCP default) | 10 |
| **Ceiling from HuginnDB alone** | **~70** |

The ceiling is rarely reached — `min_connections: 0` plus the 10-minute
`idle_timeout` means steady-state is far lower, typically 1 per pool plus
whatever is in flight. But the *burst* is real and is exactly what trips the
limit: a cross-database search opens 12 pools **concurrently**, each of which
establishes at least one connection immediately, on a server that already has
~15 sessions from the rest of the toolchain.

And once those 12 pools exist, they never go away.

MySQL's default `max_connections` is 151, so the same scenario is less acute
but not safe. MongoDB's server-side limit is high enough not to matter
directly; the 100-per-host client default matters for Atlas tier limits and
for connection-storm behaviour during replica-set failover.

---

## 3. Findings, ranked

| # | Finding | Severity | Where |
| --- | --- | --- | --- |
| F1 | Pools scale with databases browsed, not servers connected | **High** | `connection.rs:541` |
| F2 | Unbounded concurrent fan-out on cross-database search | **High** | `SchemaExplorer.tsx:902` |
| F3 | Child pools are never evicted (no TTL, no LRU, no cap) | **High** | `connection.rs:448` |
| F4 | MCP sidecar is a second uncoordinated budget, ×N clients | **High** | `mcp/mod.rs:452` |
| F5 | No per-endpoint accounting; per-profile budgets stack | **High** | `state.rs:302` |
| F6 | MongoDB pool is unbounded (driver default 100/host) | **Medium** | `mongo/mod.rs:43` |
| F7 | Keepalive (180 s) defeats idle reaping (600 s) | **Medium** | `keepalive.rs:38` |
| F8 | `too many connections` is unclassified; retry paths re-fire | **Medium** | `connectFlow.ts:37` |
| F9 | Teardown relies on `Drop` instead of `close().await` | **Medium** | `connection.rs:436` |
| F10 | No preference, no per-profile override, no live visibility | **Medium** | `prefs.rs` |
| F11 | Export/import dialogs leave a permanent pool per database | **Low** | `ExportDatabaseDialog.tsx:128` |
| F12 | Seven copies of `pool_for` | **Low** | `commands/*.rs` |

---

## 4. Target architecture

The single reframing that makes everything else fall out:

> **The unit of resource accounting must be the server endpoint, not the
> connection profile.**

### 4.1 An `Endpoint` layer

Define an endpoint key derived from the profile:

```
(driver, resolved_host, port, username, ssl, tunnel_identity)
```

`tunnel_identity` is `None` for direct connections and
`(ssh_host, ssh_port, ssh_user)` otherwise — two profiles through the same
tunnel to the same server are the same endpoint; through different tunnels they
are not.

Every pool then belongs to an endpoint, and the endpoint owns the budget:

- **MySQL** — a connection is not bound to a database (`USE db`, or qualified
  identifiers). One pool per endpoint, full stop. The per-database child pools
  disappear entirely; `open_database_view` returns a handle that carries the
  target database and every query qualifies or issues `USE`. **This is the
  single biggest win available** and it removes F1/F3 for MySQL outright.
- **PostgreSQL** — a connection *is* bound to one database, so one pool per
  `(endpoint, database)` is unavoidable. But the endpoint holds a shared
  `tokio::Semaphore` of `max_total` permits that every one of its pools must
  acquire from before checking out a connection. Twelve databases then share
  one budget instead of owning twelve.
- **MongoDB** — already one client per endpoint (`resolve_mongo_database_view`
  does the right thing). Only needs an explicit `max_pool_size`.
- **SQLite** — per file, unchanged.

### 4.2 Lifecycle: idle pools are a cache, not a commitment

Add `last_used: AtomicInstant` to `ActivePool`, touched by a **single**
consolidated `pool_for` (F12 pays for itself here). A background reaper then:

- `close().await`s and removes any `::db::` child pool untouched for
  `child_pool_idle_ttl` (default 5 min);
- enforces a hard cap of live child pools per parent (default 8), LRU-evicted;
- never touches top-level pools, which stay until the user disconnects.

Reopening a reaped child is one `open_pool` call and the schema cache in
`useSchema` is untouched, so the user cannot tell the difference.

### 4.3 One budget per machine, across processes

The GUI and every `huginndb-mcp` sidecar are separate processes competing for
the same server. Three levels of fix, in increasing order of effort:

1. **Declare a smaller footprint** (trivial). The sidecar gets
   `--max-connections N`, defaulting to **2**, not 5. A request/response AI
   connector does not need five concurrent sockets. Document the cost in
   `docs/MCP.md`.
2. **Idle shutdown** (small). The sidecar closes a pool after K minutes with no
   tool call. `sqlx` already reaps the physical connections; this removes the
   pool object too and makes the sidecar's steady-state footprint provably
   zero.
3. **Proxy to the running app** (the real fix). When the desktop app is up, the
   sidecar stops opening pools and forwards its data-path calls to it over a
   local IPC socket (Unix socket / named pipe, token-authenticated), falling
   back to direct pools when the app is not running. This makes the GUI the
   single owner of every connection on the machine: one budget, one place to
   see it, one place to cap it — and, as a bonus, MCP-driven writes become
   visible in the app's Console in real time instead of only in
   `mcp-audit.log`. This is a real project (socket, handshake, auth, fallback,
   Windows named-pipe path) and should be scoped on its own.

### 4.4 Policy is per-server, so it lives on the profile

Connection capacity is a fact about a server, and `ConnectionProfile` is where
server facts already live. Add:

```rust
/// Maximum simultaneous connections HuginnDB may hold against this
/// server, across every database view and every HuginnDB process.
/// `None` → the global preference.
#[serde(default)]
pub max_connections: Option<u32>,
```

This ships in `profiles.json`, so it exports/imports for free (`transfer.rs`),
syncs through shared origins, and — because the sidecar reads the same file —
applies to the MCP connector automatically with no extra plumbing. Note
CLAUDE.md gotcha #14: the field must be declared on both the Rust struct and
`src/types.ts` or serde drops it.

Global fallbacks in `prefs.rs` under a new `connections` section:
`max_per_endpoint` (default 5), `child_pool_idle_ttl_secs` (default 300),
`keepalive_secs` (default 180, `0` = off).

### 4.5 Make it visible

A "Connections" section in Settings (or a status-bar popover) listing every
live pool: endpoint, database, in-use / idle / max, last used, and which
process owns it once §4.3.3 lands. Plus a "Close idle pools" button.
`ActiveConnections` already holds everything; `Pool::size()` /
`Pool::num_idle()` supply the counts.

This is the difference between "HuginnDB broke my database" and "HuginnDB
showed me I had 14 pools open and let me close them".

### 4.6 Fail loudly and stop retrying

Classify the error in `AppError`:

| Driver | Signal |
| --- | --- |
| Postgres | `SQLSTATE 53300` (`too_many_connections`), `53400` |
| MySQL | error `1040` (`ER_CON_COUNT_ERROR`), `1203` |
| MongoDB | connection-pool / server-selection timeout |

On detection: a dedicated message that names HuginnDB's own footprint
("HuginnDB currently holds 14 pools against 3 servers"), a "close idle pools
and retry" action, and — importantly — a circuit breaker that makes the search
fan-out (F2) **stop** instead of re-firing on the next keystroke.

---

## 5. Proposed sequencing

### P0 — ship independently, no refactor (days)

| Change | Files | Kills |
| --- | --- | --- |
| Bound the search fan-out to 2–3 concurrent, and prompt beyond N databases | `SchemaExplorer.tsx:902` | F2 |
| Set `max_pool_size` on the Mongo client (propose 5, matching SQL) | `mongo/mod.rs:88` | F6 |
| Sidecar `--max-connections`, default 2 + idle pool shutdown | `mcp/mod.rs` | F4 (partly) |
| Classify `too many connections`; circuit-break the fan-out | `error.rs`, `connectFlow.ts` | F8 |
| Smaller child pools: `max_connections: 2` for `::db::` children | `pool.rs`, `connection.rs:611` | F1 (partly) |
| Document the multi-process footprint | `docs/MCP.md` | — |

The child-pool change alone takes the 12-database ceiling from 65 to 29.

### P1 — bounded lifecycle (1–2 weeks)

- Consolidate the seven `pool_for` into one, with `last_used` tracking (F12).
- Idle child-pool reaper: TTL + LRU cap (F3).
- Make `disconnect` `async` and `close().await` each pool with a timeout;
  same in the environment-switch teardown; add an app-exit close hook (F9).
- Explicit `min_connections(0)` / `idle_timeout` / `max_lifetime` /
  `acquire_timeout` on every `PoolOptions`, so the values are deliberate and
  reviewable rather than inherited (§1.1).
- Keepalive only where it earns its keep: tunnelled connections always, plain
  TCP only when the connection has been idle past a threshold, and make the
  interval a preference with `0` = off (F7).
- `connections` preferences + `ConnectionProfile.max_connections` + the
  Settings visibility panel (F10).

### P2 — the endpoint layer (the actual refactor)

- Endpoint key + registry, per-endpoint semaphore (F5).
- MySQL: collapse per-database child pools into one endpoint pool (F1).
- Postgres: keep per-database pools, share the endpoint budget.

### P3 — cross-process

- Sidecar proxies to the running app over local IPC (§4.3.3), with a direct
  fallback.

---

## 6. Explicitly rejected

- **Just raising `max_connections`.** The complaint is the opposite direction.
- **Dropping to `max_connections: 1`.** The batch runner
  (`query.rs:679`) holds one connection for a whole multi-statement batch to
  preserve session semantics; a background schema refresh during a long batch
  would deadlock on a single-connection pool. Two is the floor for a pool that
  can be used interactively.
- **Reference-counting profiles onto a shared pool without an endpoint key.**
  It looks like a shortcut to §4.1 but gets tunnels and differing credentials
  wrong. The endpoint key is the part that has to be right.
- **A connection pooler as a hard dependency** (pgbouncer et al.). Out of scope
  for a desktop client, though ROADMAP item 4 already tracks *tolerating* one
  correctly (transaction-mode poolers reject prepared statements, which `sqlx`
  assumes) — and a small per-endpoint budget is strictly better behaviour
  through a pooler too.

---

## 7. Open questions

1. **MySQL `USE` vs. qualified identifiers** for §4.1. `USE` is stateful and
   therefore hostile to a shared pool (any connection could be left pointing
   anywhere); fully-qualified `` `db`.`table` `` in every generated statement is
   safer but touches every SQL builder, and user-typed SQL in the query editor
   still needs a bound database. Likely answer: qualify what we generate, and
   `USE` on checkout for the query editor's own connection.
2. **Does the endpoint key include the username?** Two profiles as different
   users are different sessions server-side and must not share a pool — so yes.
   But it means "same server, two users" still stacks budgets, and the *server*
   limit is global. The semaphore may need to be keyed on `(host, port)` while
   the pool is keyed on the full tuple.
3. **How aggressive should the child TTL be?** Five minutes is a guess. Worth
   instrumenting before picking.
4. **Should `visible_databases` gate pool creation, not just display?** Today
   it scopes the search fan-out but nothing stops another path from opening a
   view on a hidden database.
