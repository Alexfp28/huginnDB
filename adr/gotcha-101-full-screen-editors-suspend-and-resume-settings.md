# Gotcha #101: A full-screen editor opened from Settings puts Settings aside, then gives it back

**Fecha:** 2026-09-25

Settings is a `workbench` dialog, and so are the shared-origin editor (`OriginEditorOverlay`) and the managed-policy editor (`PolicyEditorDialog`). Both editors are opened from a Settings section. A workbench is never stacked on another one: Radix traps focus in whichever mounted last. The origin editor already followed that rule, but only halfway.

## What was wrong

- **The origin editor closed Settings on the way in and never reopened it.** Leaving the editor, saved or not, dropped the user on the main window, not back in Settings → Origins where they came from. Alex found it on 2026-09-25.
- **The policy editor broke the rule.** It was rendered inside Settings → Policy, a workbench stacked on a workbench. It looked fine because closing it revealed Settings underneath. But anything that closed Settings also unmounted the editor, since the editor was a child of it.

## Detail

- **`useSettingsDialog` has `suspend()` and `resume()`.**
  - `suspend()` closes Settings and records `suspendedAt = section`. It does nothing if Settings is not open.
  - `resume()` reopens Settings on `suspendedAt` and clears it. It does nothing if `suspend()` did not close Settings.
  - `openAt`, `openAtPref` and `setOpen` clear `suspendedAt`. An explicit open or close supersedes a pending return.
- **Each editor is a store plus a sibling of Settings in `App`.** `useOriginEditor` and `usePolicyEditor` call `suspend()` in `open` and `resume()` in `close`. `App` mounts `<OriginEditorOverlay />` and `<PolicyEditorHost />` next to `<SettingsDialog />`, never inside it.
- **"Return to Settings" falls out of where the editor was opened from, without a flag.** The origin editor also opens from a connection's "edit at origin" banner and from the republish prompt. There, Settings was not open, so `suspend()` records nothing, and closing the editor leaves Settings closed.
- **`usePolicyEditor` holds a snapshot of the `PolicyStatus`** that Settings → Policy was showing. The editor needs it only for the current account, which it uses as the template's author and for the "your own role changes" warning. `onSaved` is optional now, because Settings → Policy reads the status again when `resume()` remounts it.
- **Panel dialogs on top of Settings are not affected.** `GrantScriptDialog`, `CaptureShortcutDialog` and `ImportVsCodeThemeDialog` are `panel` tier. A small dialog over a workbench is the app's normal pattern (`ConfirmDialog` does the same). The rule is about one workbench on another.
- Tests: `stores/dialogs/settingsReturn.test.ts`.
