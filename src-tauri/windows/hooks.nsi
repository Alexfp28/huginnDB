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

; NSIS_HOOK_POSTINSTALL runs after every install, fresh or update. It hands
; the silent updater's schedule to the app itself (`--ensure-schedule`, see
; `src/updater/schedule.rs`) rather than calling `schtasks` from here, so
; there is one implementation with tests instead of one in NSIS and one in
; Rust: the app registers the logon and daily tasks for the current user,
; falls back to a HKCU Run value when the domain refuses the logon task, and
; records what it managed to do for Settings -> About. It honours the user's
; "Install updates in the background" preference, and it never fails the
; install: a refused schedule is an outcome, not an error.
!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\huginndb.exe" --ensure-schedule'
!macroend

; NSIS_HOOK_PREUNINSTALL runs while the executable is still there to ask:
; removing HuginnDB removes the tasks and the Run value with it, instead of
; leaving Task Scheduler pointing at a file that no longer exists.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\huginndb.exe" --remove-schedule'
!macroend
