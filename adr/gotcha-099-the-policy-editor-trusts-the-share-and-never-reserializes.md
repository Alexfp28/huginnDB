# Gotcha #099: The policy editor lets the share decide who edits, validates text it never re-serializes, and never leaves the path without a file

**Fecha:** 2026-09-24

Phase 4 of managed policy gives the policy an in-app editor. This entry covers the backend (`policy::editor`, four commands in `commands::policy`) and the two changes it forced elsewhere: a replace that never removes the destination, and a loader that tolerates a moment's absence.

## Detail

- **No "administrator" in the app.** The policy is not signed (D6), so the share's permissions are what stop a user rewriting it. They are therefore also what decides who may use the editor:
  - it opens for anyone;
  - `save` requires `state_file::probe_writable` to succeed on the file's folder;
  - Windows refuses the write for everyone else.

  A list of administrators inside the policy would be a second, contradictable answer, and it would protect nothing: whoever can write the file can edit it by hand. This is the three-layer model of ADR 56 again, where the probe is the authority.
- **Only a `file` anchor is edited in place.** `anchor_info()` reports:
  - `none`;
  - `file` (`Anchor::Source`, normally a share);
  - `registry` or `systemFile` (an inline policy, which needs machine admin rights and is offered as "export to a file" through `create`);
  - `error`.

  `policy_save` reads the path from the anchor itself and never from the caller. The editor therefore saves *the policy*, not whatever file a request names.
- **Text in, text out.** The model is `Deserialize`-only with `deny_unknown_fields`, and it stays that way. The draft is the JSON text (the frontend keeps it as the parsed object, which preserves key order). Every check runs `PolicyDoc::parse`, the parser that applies the policy, and the bytes saved are the bytes validated. A round trip through structs could drop what this version does not model, and would need a second serializer to keep in step with the parser. `save` refuses text that does not parse, so the editor can never publish the `relatons` outage.
- **Conflicts and backup work as in the origin editor.**
  - The SHA-256 of the bytes as opened travels with the draft. `""` means the file did not exist.
  - It is compared with the file as it is at save time. A mismatch is `SaveOutcome::Conflict { text, base }`, an outcome rather than an `Err`, so it can carry the current file.
  - `.bak` is a copy, and its errors are swallowed.
  - `sha256_hex`, `mtime_of`, `probe_writable` and `WritableProbe` moved from `commands::origin_doc` to `state_file`, so both editors use one implementation.
- **`write_replace`, not `write_atomic`.**
  - `write_atomic` removes the destination before renaming onto it. A machine reading in that window finds no policy, the policy goes Broken, and every connection on that machine is locked until its next read, five minutes later.
  - `std::fs::rename` already replaces on Windows (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`), so the removal is unnecessary. `write_replace` writes a uniquely named temp file in the same directory, `fsync`s it, and renames.
  - A reader holding the file open without delete sharing makes the rename fail with `PermissionDenied`. That is retried briefly and is never answered by removing the file.
  - `write_atomic` itself is left as it is: its callers write the app's own files or the origin document, whose readers tolerate a vanished file differently.
- **The loader settles before it breaks.** `settle(prev, load, pause)` re-reads up to `RETRIES` (3) times, `RETRY_PAUSE` (400 ms) apart, but only when:
  - the previous state was `Active`, and
  - the new one is a *read* failure: Broken whose error starts with `cannot read`, the prefix every anchor and `fetch` error carries.

  A policy that reads but does not parse breaks at once, since re-reading returns the same mistake. A machine that was never Active does not wait either. This is what makes another machine's save, or a share that blinks, harmless.
- **`reload_now`.** A save calls it, then emits `CHANGED_EVENT`, so this machine and every window apply the new policy immediately instead of at the next tick. Other machines, and the MCP sidecar, still read it on their own five-minute tick. `create` emits only if the reload changed something, which happens when this machine was already pointed at that path.
- **The preview is the enforcement decision.** `enforce::connection_access(doc, user, profile, id, subject)` was extracted from `access()`, which now wraps it. `editor::preview` calls it for any user under a draft, once as `Human` and once as `Ai`, plus `pinned_db_user`. What the editor shows is therefore what the commands would decide. Only profiles in memory are read, never a database.
- **Off the main thread, guarded as `none`.** Open, save and create run on `spawn_blocking`, because a share can take its SMB timeout to answer. The four commands are `none` in `HUMAN_POLICY`: they touch no database, and their authority is the write, not the policy.
- **`create` refuses an existing file.** Replacing one is `save`'s job, with its conflict check. `create` returns the `reg add … /v PolicySource` command and the registry key and value for GPO or Intune, and warns when the path is not a UNC path, because a drive letter can differ from machine to machine.
