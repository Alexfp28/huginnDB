; Custom NSIS installer hooks for HuginnDB (see tauri.conf.json's
; bundle.windows.nsis.installerHooks).
;
; NSIS_HOOK_PREINSTALL runs before Tauri's generated installer copies any
; files, sets registry values, or creates shortcuts. Tauri's own template
; already knows how to close a running instance of the main `huginndb.exe`
; before overwriting it, but the `huginndb-mcp` sidecar is spawned
; independently by external MCP clients (Claude Desktop, Claude Code, ...) —
; nothing in the app's own lifecycle ever starts or stops it. If a client
; still has it running when an update installs, Windows holds a lock on
; `huginndb-mcp.exe` and the install fails with what looks like a
; permissions error (it's actually ERROR_SHARING_VIOLATION — ordinary
; per-user APPDATA installs don't need elevation for this). Force-killing it
; here clears the lock; the MCP client just respawns it the next time it
; needs the connector, same as if the machine had rebooted.
!macro NSIS_HOOK_PREINSTALL
  ExecWait 'taskkill /F /IM huginndb-mcp.exe /T'
!macroend
