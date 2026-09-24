# HuginnDB managed policy — design rationale and phased build-out

Status: **planned, not started.** This document is the specification for
*managed policy*: per-role permissions, set by an administrator in one place,
that bound what each **person** can do in HuginnDB and what an **AI** acting for
that person can do, on every installation in an organization.

It is written to be executed one phase at a time. Every phase states what to
build, what "done" means, and what *not* to do. Read the whole document before
starting phase 1 — decisions in later phases constrain earlier ones.

Companion documents:

- [`ENVIRONMENTS.md`](ENVIRONMENTS.md) — shared origins, the existing way a
  team distributes connections from a network share. Policy reuses its file
  delivery, **not** its trust model (see §4).
- [`MCP.md`](MCP.md) / [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) —
  the connector whose per-connection write policy this generalises.
- [`AI.md`](AI.md) — the in-app AI panel, the second AI surface policy binds.

---

## 1. The problem

HuginnDB is being prepared for sale to organizations. Installing it on every
workstation is not the objection; **configuring and auditing permissions on
every workstation individually is.** The requirement, as stated by the
prospective customer:

- **Visibility / access** per user or role: whether a database, table or view
  can be read at all — *including* discovery through system catalogs
  (`INFORMATION_SCHEMA`, `sys.*`, `master`, `pg_catalog`, `sqlite_master`,
  `listCollections`), so a restriction cannot be bypassed by asking the catalog.
- **Write** per user or role: `SELECT` only, or `INSERT`, `UPDATE`, and
  `DELETE` as a **separate** grant.
- Scoped by department: *sales reads the billing tables and views; production
  only sees its own area.*
- It applies to **people and to the AI alike.** An administrator must be able to
  answer, in one place, both "what can each user do on my databases?" and "what
  can the AI do on my databases?".
- Administered **once**, affecting every installation.

Out of scope for this document: Active Directory / LDAP identity. Every customer
integrates differently; identity is the OS user name (§5.1) until a customer
needs more.

## 2. Decisions already taken

| # | Decision | Why |
|---|----------|-----|
| D1 | A role carries **two permission blocks, `human` and `ai`, with `ai ⊆ human`.** | The AI never does more than the person it works for, so the two policies cannot drift apart; an admin can still give the AI less (e.g. sales writes billing, its AI only reads it). |
| D2 | For people, v1 is a **guardrail plus per-user database credentials**, and HuginnDB **generates the `GRANT` script** from the policy. | See §3. The database is the only thing that can enforce against a person who holds the password. |
| D3 | **Free SQL is disabled** (query editor for people, `run_query`/`run_write` for the AI) in any rule whose scope is narrower than the whole connection. | Extracting the relations a statement touches is not solvable airtight across five dialects (§6.3). Structured surfaces can be filtered exactly. |
| D4 | The policy is anchored per machine in **both** the HKLM registry and a system-directory file; the registry wins. | Same shape as VS Code and Claude Code (§8). The file works without Group Policy and on every OS; the registry is what GPO/Intune deploy. |

## 3. What can and cannot be enforced — say this to customers verbatim

**For the AI, HuginnDB is the enforcement point, and it is airtight.** The model
never holds a database credential; `huginndb-mcp` and the AI panel do, and every
request passes through one choke point (`BridgeRequest`, §6.1). If policy
refuses a request, the model cannot perform it.

**For a person, HuginnDB alone is a guardrail.** A person whose workstation
holds the database password — in their OS keychain, or recoverable from a
shared origin with the passphrase — can open any other client and ignore
HuginnDB's policy. So the product claim is:

> HuginnDB applies your policy to people and to the AI. To make it impossible
> for a person to bypass, give each person their own database user —
> HuginnDB generates the grants that make the database agree with the policy.

A third option — a server that holds every credential so none reaches a
workstation (a "gateway" / tenant) — would make HuginnDB the enforcement point
for people too. It is a different product (months, a server component, its own
authentication) and is **not** part of this plan.

## 4. Why shared origins are not enough on their own

Origins already put a file on a share that many installations read. But an
origin is **attached by the user**, on their own machine, and can be detached
by the same user; its per-connection trust flags (`mcp_write`, `mcp_exposed`,
`ai_*`, `pulse_enabled`) are deliberately preserved *locally* against the
publisher (`merge_into`). Both properties are right for origins and wrong for
policy. Policy therefore:

- is located by a **machine-level anchor** a standard user cannot write (§5.2);
- **overrides** local settings, with one exception: a local setting may only
  *narrow* policy, never widen it (effective = policy ∩ local, the same rule
  Claude Code applies to a stricter lower-level value);
- may reuse the origin code path for *reading and watching* a file on a share.

## 5. The policy document

### 5.1 Identity

The subject is the **OS user name** of the process — the app, or the
`huginndb-mcp` sidecar the user's AI client launched (both run as the user).
Matched case-insensitively, with or without the `DOMAIN\` prefix. It is not
verified against anything; the user list is maintained by hand. A user not
listed gets `defaultRole`, which should be the most restrictive role.

### 5.2 Anchors (D4)

Read in order; **the first source that carries a policy wins**, the rest are
ignored (no merging across sources in v1):

1. **Registry** `HKLM\SOFTWARE\Policies\HuginnDB` — value `Policy` (REG_SZ,
   the JSON inline) or `PolicySource` (REG_SZ, a path to the JSON, typically
   on a share).
2. **File** `managed-policy.json` in the system directory:
   `C:\Program Files\HuginnDB\` (Windows), `/etc/huginndb/` (Linux),
   `/Library/Application Support/HuginnDB/` (macOS). Same two shapes: the
   policy inline, or `{ "source": "\\\\server\\share\\huginn-policy.json" }`.

`HKCU` is **not** a source: it is user-writable.

No anchor → the installation is unmanaged and behaves exactly as today.

### 5.3 Shape (sketch — the real schema ships as a JSON Schema)

```json
{
  "version": 1,
  "defaultRole": "none",
  "users": { "scara": ["admin"], "alopez": ["sales"] },
  "roles": {
    "none": { "rules": [] },
    "sales": {
      "rules": [{
        "endpoint": { "driver": "mysql", "host": "erp.local", "port": 3306 },
        "databases": ["billing"],
        "relations": { "allow": ["invoices", "v_invoice_*"], "deny": ["cards"] },
        "human": ["select", "insert", "update", "export"],
        "ai": ["select"]
      }]
    },
    "admin": {
      "rules": [{
        "endpoint": "*",
        "human": ["select", "insert", "update", "delete", "ddl", "export", "monitor"],
        "ai": ["select"]
      }]
    }
  },
  "unmanagedConnections": "allow"
}
```

Semantics:

- **Rules match by endpoint, not by profile id.** A profile id is local and
  free to mint: a user who re-creates a connection by hand would get a fresh id
  the policy has never heard of. The endpoint (driver + normalised host +
  effective port + tunnel, i.e. `db::endpoint::EndpointKey`) is what the server
  actually is. SQLite has no endpoint key; its rules match the file path.
- **Scope:** `databases` / `schemas` / `relations` accept `*` globs; absent
  means "all". `deny` wins over `allow`, and across multiple roles of one user
  any deny wins.
- **Verbs:** `select`, `insert`, `update`, `delete`, `ddl`, `export`
  (reading is not exporting: it is the channel data leaves by), `monitor`
  (Pulse, sessions, the Security panel — they show *other users'* statement
  text, which can carry data from relations this role cannot read).
- **`ai ⊆ human`** is validated when the policy is loaded; a violating rule is
  **intersected** at runtime and reported in diagnostics, never widened.
- **Endpoints no rule matches** are unreachable for managed users when
  `unmanagedConnections` is `"deny"`; with `"allow"` they behave as today
  (a developer's local SQLite, say). Default: `"deny"`.

### 5.4 Failure: closed, never open

An anchor that exists but cannot be read or parsed, or a `source` that cannot be
reached, **fails closed**: managed endpoints become read-nothing for people and
unreachable for the AI, with a banner naming the source and the error. It never
falls back to "unmanaged". (Offline laptops: see open question Q2.)

## 6. Enforcement

### 6.1 The AI — airtight

Every AI request, from the MCP sidecar and from the AI panel, is a
`BridgeRequest`. Policy is checked **there**, in `bridge::server`, beside the
existing `McpWritePolicy` re-check — never only in the sidecar and never in the
frontend.

- **Discovery is filtered, not refused.** `ListDatabases`, `ListTables` and
  friends return only what the rule's scope admits, so a model does not learn
  the names of relations it cannot read.
- **Structured tools** (`browse_table`, `describe_table`, `insert_row`,
  `update_cell`, `delete_rows`, …) name their relation, so they are checked
  exactly: scope, then verb (`insert_row` → `insert`, `update_cell` →
  `update`, `delete_rows` → `delete`).
- **`run_query` / `run_write`** exist only where the rule's scope is the whole
  endpoint (D3). Otherwise they are **removed** from the catalogue for that
  connection rather than refused — the same rule the AI panel's metadata-only
  mode already follows (gotcha #74).
- `pulse_*`, `list_users` and `list_privileges` require `monitor`.
- The audit log records the OS user and the resolved role(s) on every call.

The AI's exposure map in `ai/tools.rs` stays exhaustive with no `_` arm
(gotcha #71); policy adds a check, it does not add an escape hatch. Gotcha #49's
three unenforced `_ => None` arms are a hazard here: phase 1 must make at least
`policy_id_of` exhaustive before policy depends on it.

### 6.2 People — guardrail, enforced in the backend

Enforced in the Tauri **commands**, with the UI mirroring the result, so hiding
a button is never the only thing that stands in the way:

- explorer: databases/relations outside scope are not listed;
- grid: insert / edit / delete follow the verbs;
- query editor: absent for scoped rules (D3);
- structure editor, import, JSON-row insert: need `ddl` / `insert`;
- export: needs `export`; Pulse / Security panel: need `monitor`;
- every locked control shows *managed by your organization*.

### 6.3 Why free SQL is not filtered (D3)

To allow free SQL under a relation scope, HuginnDB would have to name every
relation a statement touches: through views, CTEs, functions, synonyms,
cross-database names, dynamic SQL (`EXEC`, `PREPARE`, `sp_executesql`) and the
system catalogs. `classify` was already caught out by a far easier question
(gotcha #76). A best-effort extractor can come later as a *warning*; it must
never be the thing a customer's restriction depends on. Where free SQL is
needed under a scope, the answer is a restricted database user (§7), and a
later version may allow free SQL on a rule that declares it is backed by one.

### 6.4 Splitting the write tier

`StmtClass::DataWrite` becomes three verbs, and classification returns a
**set** of verbs rather than one ordered tier (still the union over every
statement in the batch, gotcha #76). Mixed statements claim every verb they can
perform:

| Statement | Verbs |
|-----------|-------|
| `INSERT … ON CONFLICT DO UPDATE` / `ON DUPLICATE KEY UPDATE` / upsert | insert + update |
| `MERGE` | insert + update + delete |
| MySQL `REPLACE` | insert + delete |
| `TRUNCATE` | ddl (unchanged) |
| Mongo `insert*` / `update*` / `replaceOne` / `delete*` | insert / update / update / delete |
| Mongo `findOneAndReplace` / `findOneAndUpdate` / `findOneAndDelete` | update / update / delete |
| Mongo `bulkWrite` | union of its operations |

`McpWritePolicy` survives as the unmanaged per-connection setting and maps
onto the verb sets (`ReadOnly` = {select}, `Data` = {select, insert, update,
delete}, `Full` = + ddl). On a managed endpoint it can only narrow (§4).

## 7. Making it real for people: per-user credentials and `GRANT` generation (D2)

- An origin can already publish a connection whose consumers keep their own
  password (`ConnectionProfile::secret_override`, gotcha #69). Per-user
  credentials need the same for the **user name**.
- From a role's rules HuginnDB generates a script for a database role —
  PostgreSQL / MySQL / SQL Server `GRANT`s, MongoDB `createRole` privileges —
  for the admin to review and run. HuginnDB never runs it by itself.
- Catalog visibility is part of the script where the engine allows it, and the
  script's comments say what it cannot hide:
  - MySQL and SQL Server only show objects the user holds a permission on;
    SQL Server's `sys.databases` still lists every database unless
    `VIEW ANY DATABASE` is revoked from `public`, which the script offers.
  - MongoDB: `listCollections` / `listDatabases` with `authorized*`.
  - PostgreSQL: `information_schema` is filtered, but `pg_catalog` shows every
    relation **name** to everyone. Data stays protected; names do not.
  - SQLite has no users; only the file's ACL protects it.

## 8. Prior art

**VS Code enterprise policies.** Windows Group Policy (ADMX/ADML templates,
values under `HKLM\Software\Policies\Microsoft\VSCode`, since 1.69), macOS
`.mobileconfig` profiles (1.99), Linux `/etc/vscode/policy.json` (1.106). A
policy overrides the setting at every level and the UI marks it as managed by
the organization; *Developer: Policy Diagnostics* reports what applied.
Relevant policies: `AllowedExtensions`, `ChatMCP`,
`ChatAllowedMcpServers` / `ChatDeniedMcpServers`, `ChatAgentMode`,
`ChatToolsAutoApprove`, `TelemetryLevel`, `UpdateMode`. Its policies are per
machine with no roles — differentiation comes from GPO targeting AD groups,
which is why this design carries roles inside the document instead.

**Claude Code managed settings.** `managed-settings.json` in
`C:\Program Files\ClaudeCode\` (or the same JSON under
`HKLM\SOFTWARE\Policies\ClaudeCode`), above every other settings level;
permission rules per tool as `allow` / `ask` / `deny` with deny winning; a
present-but-unparseable admin source **refuses to start**; `HKCU` is only a
fallback because it is user-writable. Its docs note a local administrator can
edit the managed source — which holds here too.

## 9. Phases

1. **Core, AI enforcement.** Verb split in `classify` (§6.4) with tests; a
   pure resolver *(policy, user, endpoint, relation, verb) → allow/deny* with
   exhaustive tests; anchor loading (§5.2) and fail-closed (§5.4); enforcement
   in `bridge::server` for the MCP sidecar and the AI panel (§6.1); make
   `policy_id_of` exhaustive (gotcha #49); a read-only **Policy diagnostics**
   view: source, user, roles, effective permissions per connection.
   *Done:* a managed user's AI cannot list, read or write outside its rule,
   proven by tests at the bridge.
2. **People.** Command-level enforcement and UI mirroring (§6.2), lock
   indicators, `unmanagedConnections`.
3. **Real enforcement for people.** Per-user user name on origin profiles;
   `GRANT` / `createRole` script generation (§7).
4. **Authoring.** An in-app editor for the policy document (today: a JSON file
   validated by the shipped JSON Schema), ADMX/ADML templates for GPO.

Not in any phase: AD/LDAP identity, a gateway server, filtering free SQL.

## 10. Open questions

- **Q1 — Signing.** A share whose ACL lets users write makes the policy
  editable by the people it restricts. Signing the document (key pair; public
  key in the anchor) detects that, and also makes an offline cache safe. It
  needs a new dependency (e.g. an Ed25519 crate) — to be approved first.
- **Q2 — Offline.** Without signing, a cached copy lives in a user-writable
  directory and could be edited, so v1 has no cache: unreachable share =
  fail closed. Acceptable for laptops?
- **Q3 — Multiple roles per user.** Union of allows with deny winning (as
  sketched), or exactly one role per user in v1?
- **Q4 — Licence.** The repository is MIT. If managed policy is the part that
  is sold, it needs a separate licence (open core). A business decision, to
  settle before phase 1 ships publicly.
