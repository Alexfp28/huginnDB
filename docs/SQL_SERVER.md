# Microsoft SQL Server

SQL Server rides the same SQL path as PostgreSQL and MySQL — browse, filter,
sort, edit cells, insert and delete rows, export, the security panel, the MCP
connector. What differs is the connection setup, a handful of T-SQL specifics,
and a list of surfaces that are not written yet.

**Server floor: SQL Server 2012.** Paging uses
`OFFSET … ROWS FETCH NEXT … ROWS ONLY`, which 2008 and older don't have. Azure
SQL works.

It is also the one driver not built on `sqlx` — that project dropped MSSQL
support after 0.6 — so it uses `tiberius` with a small session pool of our own.
That is an implementation detail with one visible consequence: after a transport
error (a dropped socket, a TLS failure) the session is discarded instead of
being reused, because we no longer know where we are in the TDS stream.
Session count follows the same per-server allowance as every other driver
(**Settings → Connections**), since a TDS session costs the server what a
Postgres backend does.

## Connecting

SSMS has a single **Server name** box, so `HOST\INSTANCE` is the form people
type. You can paste that into **either** the host field or the **Instance name**
field and HuginnDB splits it for you — the dialog shows the split on blur rather
than normalising silently behind your back.

- **With an instance name**, the port is resolved through the **SQL Browser**
  (UDP 1434), because a named instance normally listens on a dynamic port. A
  port you typed is kept as a *fallback* for a stopped or firewalled Browser —
  but only when it isn't 1433: retrying the default port on a host that is
  dropping UDP just buys a second connect timeout.
- **Trust server certificate** exists because SQL Server encrypts the
  connection by default and most on-premise instances present a self-signed
  certificate, which can't be validated. That's why this driver has its own
  switch instead of the shared SSL checkbox.
- **Authentication** is a SQL Server login, or **Windows (NTLM)** — the latter
  only on Windows, where the option appears at all. On Linux and macOS the
  driver is SQL-login-only.
- **A named instance cannot be tunnelled over SSH.** The SQL Browser is a
  separate UDP service, so the combination is refused up front rather than
  quietly connecting to the wrong port. A tunnel to an instance on a known
  static port works — give the port and leave the instance name empty.

Leaving **Database** blank gives you the whole server, same as the other SQL
drivers: the explorer lists the databases and each one you open gets its own
pool.

## How values come back

| Type | Rendered as | Why |
| --- | --- | --- |
| `decimal`, `numeric` | Exact text | They are arbitrary precision on the server; an `f64` step would round them silently. Exact at the type's full 38 digits, negatives included. |
| `money`, `smallmoney` | Number | The driver decodes these to a double at the protocol layer, before HuginnDB sees them. Exact for everything up to roughly ±900 billion; above that, use `decimal` if you need the last digits. |
| `bit` | `0` / `1` | Not a JSON boolean, so the grid's BIT display preference and its dedicated 0/1 editor keep working. Same call as MySQL's `TINYINT(1)`. |
| `binary`, `varbinary`, `image` | `0x…` hex | The literal form T-SQL itself accepts, so a copied cell pastes straight back into a query. |
| `uniqueidentifier` | Text | |
| dates and times | ISO-ish text | `datetime`, `datetime2`, `smalldatetime`, `date`, `time`, `datetimeoffset`. |

A few write-side details you don't have to do anything about, but which explain
what you see in the Console:

- **Paging injects `ORDER BY (SELECT NULL)`** when you haven't sorted a column,
  because T-SQL's `OFFSET/FETCH` requires an `ORDER BY`.
- **Inserts use `OUTPUT INSERTED.<pk>`** to recover the generated key — which
  also catches a `uniqueidentifier` or sequence default, not just `IDENTITY`.
  SQL Server refuses `OUTPUT` on a table with triggers (error 334), so that
  case is detected and retried with `SCOPE_IDENTITY()`.
- **Editing a binary column wraps the value in `CONVERT(varbinary(max), …, 1)`.**
  Values travel as text, and T-SQL's implicit `nvarchar` → `varbinary`
  conversion reinterprets the *characters*, so saving the `0x4A2B` the grid
  shows would otherwise store the ASCII of that string.
- **A cell edit is a real transaction.** The guard that refuses to touch more
  than one row runs as `BEGIN` / `COMMIT` / `ROLLBACK` statements on one held
  session, since `tiberius` has no transaction handle.

## Not implemented yet

These are gated in the UI — the affordance isn't there rather than failing when
you click it — and refused by the backend too, so neither can drift into wrong
T-SQL:

| Surface | Note |
| --- | --- |
| Structure editor (visual `ALTER TABLE`) | Structure is read-only. The T-SQL DDL builder isn't written. |
| Rename a table or view | T-SQL renames through `EXEC sp_rename`, whose arguments are strings rather than identifiers; it is wired up with the rest of the DDL work. |
| View editor | Create/edit/drop a view. Views themselves are browsable. |
| `.sql` export and import | Needs a per-driver literal encoder. Grid data still exports to CSV/JSON. |

Working today, for contrast: `CREATE DATABASE` / `DROP DATABASE`, `TRUNCATE`
("Empty table"), dropping a table, the security panel (users, roles and
privileges), multi-database browsing, and every MCP read and data-write tool.

## Over MCP

Nothing SQL Server-specific to configure: it is exposed exactly like the other
SQL drivers, with the same per-connection write policy. The one gap follows the
table above — `apply_structure_change` returns an "unsupported driver" error
there, so an assistant can read the schema and write rows but cannot alter the
schema. See [`MCP.md`](MCP.md).
