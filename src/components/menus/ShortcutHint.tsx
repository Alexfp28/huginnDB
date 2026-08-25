/**
 * The current shortcut for an action, right-aligned inside a menu item —
 * or nothing at all when the action ships unbound, which most of the
 * catalogue deliberately does.
 *
 * A component rather than a `useShortcutLabel` call per item because the menus
 * carry ~15 of these between them, and each one would otherwise be a hook plus
 * a conditional at the call site. It reads the live binding, so a rebind shows
 * up here without a reload.
 */

import { DropdownMenuShortcut } from "@/components/ui/dropdown";
import { useShortcutLabel, type ActionId } from "@/lib/keybindings";

export function ShortcutHint({ action }: { action: ActionId }) {
  const label = useShortcutLabel(action);
  if (!label) return null;
  return <DropdownMenuShortcut>{label}</DropdownMenuShortcut>;
}
