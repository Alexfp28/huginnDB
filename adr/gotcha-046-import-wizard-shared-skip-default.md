# Gotcha #046: The three import dialogs share useImportWizard with one default conflict action

**Fecha:** 2026-09-03

Profiles, environments and JSON Schemas all run pick → passphrase → conflicts → done over `lib/transfer/useImportWizard.ts`; the shared `"skip"` default (previously an inconsistent `"rename"` vs `"skip"`) is what stops re-importing your own export from accumulating renamed duplicates.

## Detail

**The three import dialogs share `lib/transfer/useImportWizard.ts`, and the `"skip"` default lives there.** Profiles, environments and JSON Schemas all run `pick → (passphrase) → (conflicts) → done` over the same nine pieces of state, and their `doImport` bodies were byte-identical including the `listen(IMPORT_PROGRESS_EVENT)` subscription and its `finally` (now `lib/bridges/import-progress-bridge.ts`, so the event has a module like the other seven `huginndb://` events). The default conflict action being in one place is the point: it used to be `"rename"` in one dialog and `"skip"` in the others, which is how re-importing your own export accumulated `name (imported)`, `name (2)`, … on every round trip. Each dialog supplies `analyze`/`run` and an optional `reviewStep`; the conflicts UI is `ConflictResolutionStep`.
