# Security Policy

HuginnDB handles credentials and runs arbitrary SQL against user-configured databases. We take vulnerabilities in this surface seriously.

## Supported versions

Until HuginnDB reaches `1.0`, only the latest tagged release on `main` is supported with security fixes. Pre-release builds (`alpha`, `beta`) receive fixes on a best-effort basis.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| < `0.1` | :x:                |

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
- The CSP for the Tauri webview is currently disabled (`csp: null` in `tauri.conf.json`) because Monaco needs to load worker scripts. The workers are self-hosted (no CDN dependency) — see `src/lib/monaco-setup.ts`. Tightening the CSP further is tracked as a roadmap item.
- Identifier quoting (`src-tauri/src/db/sql.rs::quote_ident`) is safe against catalog-sourced identifiers. It is **not** intended as a sanitiser for arbitrary user input; arbitrary user input goes through bound parameters (`$1`/`?`).

## Known caveats

- SSH tunnels are not yet wired up in the backend. If your database is only reachable through a bastion, you currently need to establish the tunnel externally (e.g. `ssh -L`) before connecting.
- `update_cell` only validates that a primary-key column exists; it does not verify that the new value is type-compatible with the column before sending. The driver will reject mismatched types at execute time.
