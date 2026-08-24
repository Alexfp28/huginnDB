# HuginnDB documentation

User guides for the app. Everything here is also readable **inside HuginnDB**
under **Help → Documentation**, which bundles these files at build time — no
network needed — and shows each one's last-updated date.

Every guide has a Spanish twin (`<NAME>.es.md`). English is authoritative; a
translation may lag behind, and the in-app viewer falls back to English for a
language that has none.

| Guide | What it covers |
| --- | --- |
| [Connections](CONNECTIONS.md) · [es](CONNECTIONS.es.md) | Creating connections per driver, SSL, SSH tunnels, where passwords live, server-wide connections, pool limits, keepalive, the CLI flags, export/import, and shared origins. |
| [Environments](ENVIRONMENTS.md) · [es](ENVIRONMENTS.es.md) | Named working sets: which connections are in play, which tabs and layout come back, and what an environment does *not* own. |
| [JSON Schemas](JSON_SCHEMAS.md) · [es](JSON_SCHEMAS.es.md) | Attaching a JSON Schema to a column for completion, hover documentation and advisory validation: the library, the most-specific-wins cascade, drafting one from a value, and sharing. |
| [MongoDB](MONGODB.md) · [es](MONGODB.es.md) | The `mongosh` query dialect, the document editor, aggregation pipelines and views, the index manager, renaming/moving a collection, and what isn't there. |
| [SQL Server](SQL_SERVER.md) · [es](SQL_SERVER.es.md) | `HOST\INSTANCE` and the SQL Browser, certificate trust, Windows auth, how values are rendered, and the surfaces not implemented yet. |
| [MCP connector](MCP.md) · [es](MCP.es.md) | Exposing your databases to an AI client: the binary, per-client config, the per-connection write policy, the audit log, and what to do when the client itself blocks a call. |

Repo-level documents outside this folder: [`README.md`](../README.md),
[`ROADMAP.md`](../ROADMAP.md), [`CHANGELOG.md`](../CHANGELOG.md),
[`SECURITY.md`](../SECURITY.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Internal notes

Design rationale and work-tracking, not user documentation — deliberately left
out of the in-app viewer:

| Document | Purpose |
| --- | --- |
| [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) | Why the MCP connector is a headless stdio sidecar, phase-by-phase, plus the open question of distributing it through a marketplace. |
| [`MONGODB_ROADMAP.md`](MONGODB_ROADMAP.md) | Full done/deferred split for the MongoDB driver, with the implementation hook for each open item. |
| [`CONNECTION_POOLING_ANALYSIS.md`](CONNECTION_POOLING_ANALYSIS.md) | How the connection footprint got bounded: endpoint budgets, child pools, the reaper. |
| [`CANARY.md`](CANARY.md) | The side-by-side pre-release channel: what it isolates, what it shares, how it's built. |

## Adding a guide

1. Write `docs/<NAME>.md` (and ideally `docs/<NAME>.es.md`).
2. Add its `?raw` imports and an entry to `src/lib/appInfo/docs.ts`.
3. Add `docs.entries.<id>.title` / `.description` to
   `src/lib/i18n/locales/en.json` and `es.json`.
4. Add the English file's path to `DOC_FILES` in `vite.config.ts`, so its
   last-updated date is injected.
5. Link it in the table above.

Keep the markdown to what the in-app renderer supports: headings, paragraphs,
fenced code, GFM pipe tables, flat lists, blockquotes, rules, and inline
code/bold/italic/links. It is not a full CommonMark engine.

Two things follow from how the viewer presents a guide. **Each `##` is a page**
— the viewer derives its navigation from the headings, showing the prose above
the first `##` as a cover and one `##` per page, with each `###` as a jump target
inside it. So a `##` is a unit a reader can land on cold: don't let one depend on
having just read the one before it.

**Links resolve, within limits.** `http(s)` opens in the OS browser. A `#anchor`
jumps to that heading in the same guide, and a relative link to another guide in
the table above switches to it. A link to something outside that set — a
roadmap, `../SECURITY.md` — opens on GitHub instead. A `#anchor` whose heading no
longer exists renders as plain uncoloured text and does nothing, which
`docOutline.test.ts` fails on, so a heading you rename takes its inbound links
with it.
