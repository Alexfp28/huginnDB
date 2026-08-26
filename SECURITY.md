# Security Policy

HuginnDB handles credentials and runs arbitrary SQL against user-configured databases. We take vulnerabilities in this surface seriously.

## Supported versions

Only the latest tagged release is supported with security fixes.

| Version         | Supported          |
| ---------------- | ------------------ |
| latest (`1.16.x`) | :white_check_mark: |
| older             | :x:                |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email the maintainers at `contact@shion.es` with:

1. A description of the issue, including the assumed threat model.
2. Steps to reproduce, ideally with a minimal test case.
3. Affected versions, platforms, and database drivers if relevant.
4. Your assessment of impact (information disclosure, code execution, privilege escalation, etc.).

We aim to acknowledge reports within **72 hours** and to issue a fix or mitigation within **30 days** for high-severity issues. We will credit reporters in the release notes unless you ask us not to.

## Hardening guidelines

HuginnDB is a desktop application; the threat model is primarily a malicious or compromised database on the network rather than a remote attacker reaching the user. Even so:

- Passwords are persisted to the OS keychain via the [`keyring`](https://crates.io/crates/keyring) crate. They are never written to the on-disk profile file or to any log.
- The frontend never receives a fully-formed connection string or password from the backend — the backend resolves them at the moment of use.
- All database I/O happens in the Rust process. The frontend cannot open arbitrary network sockets.
- The CSP for the Tauri webview is currently disabled (`csp: null` in `tauri.conf.json`) because Monaco needs to load worker scripts. The workers are self-hosted (no CDN dependency) — see `src/lib/monaco/monaco-setup.ts`. Tightening the CSP further is tracked as a roadmap item.
- Identifier quoting (`src-tauri/src/db/sql.rs::Dialect::quote_ident`) is safe against catalog-sourced identifiers. It is **not** intended as a sanitiser for arbitrary user input; arbitrary user input goes through bound parameters (`$1` on Postgres, `?` on MySQL/SQLite, `@P1` on SQL Server — see `Dialect::placeholder`).
- **Shared origins** (Settings → Shared origins) import connections, with their passwords, from a file on a path the OS already mounts (a UNC share, a mapped drive, a synced folder). Be clear about where the security boundary sits: the file is the same AES-256-GCM / PBKDF2-HMAC-SHA256 (600 000 iterations) export that "Export profiles…" produces, but **read access to the share plus the passphrase yields every password in it**. The passphrase necessarily travels out of band, so the real perimeter is the share's ACL, not the encryption — treat an origin file as a credential store and give it permissions to match. HuginnDB reads the path and, since 1.19.0, writes to it **only for an origin you have explicitly marked as one this machine publishes** — a per-origin role that every existing and newly registered origin starts *without*, so no install or update grants write access to a shared file. Even then the app probes the path with a real write before offering to save, so a read-only share opens the editor read-only rather than failing at the last step; the share's ACL stays the perimeter. It stores each origin's passphrase in the OS keychain rather than on disk, and never lets a sync delete a local profile or keychain entry on its own: a disappearance is reported for the user to act on, so someone with write access to the shared file cannot destroy credentials on another machine. See `docs/ENVIRONMENTS.md`.
- The headless MCP connector (`huginndb-mcp`) exposes databases to an external AI client. It is **opt-in per connection** (`--connections`) and **read-only by default**: writes require a per-connection write policy (`read-only` / `data` / `full`) set in Settings → MCP, re-read on every write attempt. Whole-table `UPDATE`/`DELETE` (no `WHERE`) are refused, `--read-only` forces read-only globally, and every write is recorded to `mcp-audit.log`. Since the connector cannot prompt, per-action approval stays with the MCP client. See `docs/MCP.md`.

## Known caveats

- SSH tunnels are implemented (`src-tauri/src/db/ssh.rs`, since 0.7.0) for every network driver — PostgreSQL, MySQL, MongoDB and SQL Server — with three host-key policies: `strict` (the fingerprint must already be in `known_hosts.json`), `accept-new` (trust on first use, strict afterwards; the default) and `accept-any`. **`accept-any` skips verification entirely and therefore offers no MITM protection** — it exists for throwaway test setups, not for reaching production through a bastion. The tunnel is single-hop (no jump-host chains), and the SSH password / key passphrase lives in the OS keychain under `${profile.id}::ssh::${username}`, never in the profile file. Two cases can't be tunnelled and are refused rather than silently connected: a MongoDB `mongodb+srv://` URI (SRV resolution happens client-side against DNS, not through the tunnel) and a named SQL Server instance (the SQL Browser is a separate UDP service the tunnel doesn't forward).
- `update_cell` only validates that a primary-key column exists; it does not verify that the new value is type-compatible with the column before sending. The driver will reject mismatched types at execute time.
