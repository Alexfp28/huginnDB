/**
 * Wires `huginndb://policy-changed` (see `src-tauri/src/policy/mod.rs`) into
 * `stores/session/policyAccess.ts`. The policy's reload thread emits it when
 * what it read differs from before — an administrator edited the file, a share
 * came back, a policy was installed or removed — and every window then forgets
 * its cached locks and asks again, instead of keeping the old ones until it is
 * reopened.
 *
 * Mounted by every kind of window that shows locked controls (`App`,
 * `DetachedTabWindow`, `PulseWindow`): each has its own copy of the store,
 * since each webview has its own JavaScript heap. Mount once per window.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePolicyAccess } from "@/stores/session/policyAccess";

const POLICY_CHANGED_EVENT = "huginndb://policy-changed";

export async function startPolicyBridge(): Promise<UnlistenFn> {
  return listen(POLICY_CHANGED_EVENT, () => {
    usePolicyAccess.getState().invalidate();
  });
}
