/**
 * Open/closed state for the two JSON Schema transfer dialogs.
 *
 * Reachable from two places (the File menu and the Settings section) and mounted
 * once — `createTransferDialogStore` documents why that needs a store.
 */

import { createTransferDialogStore } from "@/stores/dialogs/transferDialog";

export const useJsonSchemaTransfer = createTransferDialogStore();
