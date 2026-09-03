# Gotcha #018: SSH tunnel bind falls back to an ephemeral port on collision

**Fecha:** 2026-09-03

`open_tunnel` retries `bind(("127.0.0.1", 0))` on `AddrInUse` and points the pool at the actually-bound port rather than the profile's pinned one; the saved profile itself is never rewritten.

## Detail

**SSH tunnel local-port bind falls back to an ephemeral port on collision (`open_tunnel` in `src-tauri/src/db/ssh.rs`).** If the user pinned a fixed `local_port` and something else already holds it (e.g. another hand-opened tunnel on the same port), `TcpListener::bind` fails with `AddrInUse`; instead of breaking the connection we retry `bind(("127.0.0.1", 0))` and let the OS pick a free port. This is transparent because the pool is pointed at the **bound** port returned on `SshTunnelHandle.local_port`, not at `tunnel.local_port`. The saved profile is never rewritten — the override lives only for that tunnel's lifetime. `local_port = 0` (auto) skips the fallback since it can't collide.
