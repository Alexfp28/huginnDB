# Managed policy

When an organization manages HuginnDB, an administrator writes **one policy**
that every installation reads. It says, per role, what the AI may reach and do
on each database: which databases and relations it can see, and whether it may
read, insert, update, delete or change schema — each granted separately.

This guide is for the administrator who deploys it. If you are a user and want
to know what applies to you, open **Settings → Policy**.

## What this version enforces — and what it does not

**For the AI, the policy is enforced, not advisory.** The model never holds a
database password: HuginnDB does, and every request an AI makes — through the
MCP connector (`huginndb-mcp`) or the in-app AI panel — passes through one
point where the policy is checked. If the policy refuses it, the AI cannot do
it. That holds whether the app is running or the connector is running alone.

**For people, this version does not enforce the policy yet.** The `human`
permissions are read, shown in Settings → Policy, and they bound the AI (an AI
never gets more than the person it works for), but the app's own screens do not
apply them. That is the next phase. Keep in mind what it will and will not be
able to do: a person who holds a database password can always open another
client, so the way to make people's restrictions impossible to bypass is for
each person to connect with their **own database user** whose grants match the
policy.

The policy only ever **narrows**. The per-connection settings users already
have — which connections are exposed to MCP, their MCP write level, whether the
AI panel is enabled — still apply. What the AI may do is the policy *and* those.

## Where the policy goes

HuginnDB looks in two places, in this order, and uses the first that has a
policy:

1. **Registry** (Windows): `HKLM\SOFTWARE\Policies\HuginnDB`
   - `Policy` (REG_SZ): the policy JSON itself, or
   - `PolicySource` (REG_SZ): a path to the policy file, usually on a share —
     `\\fileserver\it\huginndb-policy.json`.

   This is what Group Policy and Intune write.
2. **File**: `managed-policy.json` in the system policy folder:
   - Windows: `C:\Program Files\HuginnDB\`
   - Linux: `/etc/huginndb/`
   - macOS: `/Library/Application Support/HuginnDB/`

   It can hold the policy itself, or only a pointer to the shared one:

   ```json
   { "source": "\\\\fileserver\\it\\huginndb-policy.json" }
   ```

Both places need administrator rights to write, which is the point: a standard
user cannot remove or replace them. `HKCU` is **not** read, because it is
user-writable. Nothing is read from environment variables either.

**Protect the shared file.** If the policy lives on a share, only
administrators may write to it — otherwise the people it restricts can edit it.
HuginnDB does not sign the file; the share's permissions are the protection.

HuginnDB reads the policy at startup and again **every 5 minutes**, so a change
reaches running installations without a restart.

## If the policy cannot be read

It **blocks**. If an anchor exists but the file it points to cannot be read
(the share is down, the file was moved) or is not valid, every AI request is
refused with a message naming the file and the error, and Settings → Policy
shows it in red. HuginnDB never falls back to "no policy", and it keeps no
local copy to fall back to.

While a policy on a share is being read for the first time, the AI is paused
the same way, usually for well under a second.

## The format

```json
{
  "version": 1,
  "defaultRole": "none",
  "users": {
    "ana": "sales",
    "pau": "production",
    "CORP\\scara": "admin"
  },
  "roles": {
    "none": {},
    "sales": {
      "rules": [{
        "endpoint": { "driver": "mysql", "host": "erp.corp.local", "port": 3306 },
        "databases": ["billing"],
        "relations": { "allow": ["invoices", "v_invoice_*"], "deny": ["v_invoice_cards"] },
        "human": ["select", "insert", "update"],
        "ai": ["select"]
      }]
    },
    "production": {
      "rules": [{
        "endpoint": { "host": "erp.corp.local" },
        "databases": ["prod_*"],
        "human": ["select", "insert", "update", "delete"],
        "ai": ["select", "insert"]
      }]
    },
    "admin": {
      "rules": [{
        "endpoint": "*",
        "human": ["select", "insert", "update", "delete", "ddl", "export", "monitor"],
        "ai": ["select", "monitor"]
      }]
    }
  },
  "unmanagedConnections": "deny"
}
```

Any field HuginnDB does not recognise — a typo such as `"relatons"` — makes the
whole policy invalid, and it blocks. A misspelled restriction is never read as
"no restriction".

### Users and roles

- A user is the **operating-system account** HuginnDB runs as, read from the OS
  itself. Names are compared ignoring case, with or without a `DOMAIN\` prefix.
- Each user has **exactly one role**. Listing the same account twice (for
  example `ana` and `CORP\ana`) is an error.
- Anyone not listed gets `defaultRole`. Make it the most restrictive role —
  here `none`, which reaches nothing.

### Rules

A role is a list of rules. Each rule says which server it is about and what it
allows there.

- **`endpoint`** — `"*"` for every server, or an object:
  - `host` (required), with optional `driver` (`postgres`, `mysql`,
    `sqlserver`, `mongodb`) and `port`. Hosts are compared ignoring case and
    surrounding spaces; no DNS lookup. A blank port in a user's connection
    counts as the driver's default.
  - `path` for a SQLite file (either slash, any case).

  Rules match the **server**, not the saved connection: a user who re-creates a
  connection by hand is still covered.
- **`databases`** — database names, `*` as wildcard. Omit it for every
  database on the server.
- **`relations`** — tables and views: `allow` (omit it for all) and `deny`
  (always wins). A pattern with a dot is matched against `schema.name`
  (`public.*`), one without against the name alone. On MySQL and MongoDB a
  relation's schema *is* its database, so `billing.invoices` works there too.
  Matching ignores case.
- **`human`** and **`ai`** — what the person and the AI may do:
  | Permission | Allows |
  |---|---|
  | `select` | reading rows, describing relations |
  | `insert`, `update`, `delete` | each row-level write, separately |
  | `ddl` | schema changes: create, alter, drop, truncate, indexes, views |
  | `monitor` | Pulse, server sessions, users and privileges — they show *other people's* statements, which can carry data this role cannot read |
  | `export` | exporting data (reserved for the people phase) |

  The AI never gets more than the person: whatever `ai` lists beyond `human` is
  ignored, and Settings → Policy shows a warning.

A statement that does two things needs both permissions: an upsert needs
`insert` and `update`, MySQL's `REPLACE` needs `insert` and `delete`.

### Free-form queries under a limited rule

If a rule limits **which databases or relations** can be seen (`databases`,
`relations.allow` or `relations.deny`), the AI **cannot run free-form queries**
on that connection — only the table tools (list, describe, browse, and the
row-level writes the rule allows). No tool can reliably tell from a query's text
every table it touches: views, functions, dynamic SQL and system catalogs such
as `INFORMATION_SCHEMA` or `master` would all be ways around the restriction.
A rule over a whole server keeps free-form queries, bounded by its permissions.

Discovery is filtered too: the AI's list of databases and tables only contains
what the role can reach, so it does not learn the names of the rest.

### Connections the policy does not name

`unmanagedConnections` decides what happens on a connection no rule of the
user's role matches:

- `"deny"` (the default): the AI cannot use it. This is also what makes it
  pointless to reach a server under another name (an IP address instead of its
  hostname) to get around a rule.
- `"allow"`: the policy leaves it alone, and only the user's local settings
  apply.

## Checking it

- **Settings → Policy** on any machine shows where the policy was read from,
  which account and role HuginnDB sees, and what each connection allows for the
  AI and for people.
- The MCP connector's audit log (`mcp-audit.log` in the user's config folder)
  records `user=` and `role=` on every write the AI makes.

## Limits, on the record

- A **local administrator** can edit the registry and the system folder, so
  this protects against standard users, not against the machine's owner.
  Redeploying the policy through Group Policy or your device management tool
  keeps it in place.
- The policy is read by versions of HuginnDB that support it. Keep the
  installed version under IT's control, as with any managed software.
- Server names are compared as written. A rule for `erp.corp.local` does not
  cover the same server reached as `10.0.0.5`; with `"deny"` for unmanaged
  connections, that alias is simply refused.
