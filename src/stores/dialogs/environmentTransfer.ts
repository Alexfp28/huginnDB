/**
 * Open state for the environment export/import dialogs.
 *
 * Export is a single dialog that can select **multiple** environments at
 * once — reachable both from the File menu (opens with everything selected,
 * mirroring `ExportProfilesDialog`) and from a per-row shortcut in
 * `EnvironmentSwitcher` (opens pre-selecting just that one row). Import is a
 * single global action (triggered from the File menu, which doesn't target
 * any environment in particular — it always creates new ones).
 *
 * The state itself is `createTransferDialogStore`'s, shared with the JSON Schema
 * pair; see that module for why it is a store at all.
 */

import { createTransferDialogStore } from "@/stores/dialogs/transferDialog";

export const useEnvironmentTransfer = createTransferDialogStore();
