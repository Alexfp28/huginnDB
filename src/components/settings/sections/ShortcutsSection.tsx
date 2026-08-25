/**
 * Editable keyboard-shortcut list (issue #75). Each row can be rebound by
 * clicking it and pressing a new combo; conflicts with another action's
 * binding block the save and surface an inline error instead of silently
 * swapping or unbinding anything.
 *
 * Bindings are a *list* per action (primary first, aliases after), so a row
 * shows every combo that fires it — including the non-rebindable `fixed` ones
 * the catalogue declares, which used to be `if` branches in `App.tsx` and were
 * therefore invisible here.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePreferences, selectKeybindings } from "@/stores/preferences/preferences";
import {
  ACTIONS,
  findConflicts,
  userBindings,
  type ActionId,
} from "@/lib/keybindings";
import { ShortcutRow } from "./ShortcutRow";

export function ShortcutsSection() {
  const { t } = useTranslation();
  const keybindings = usePreferences(selectKeybindings);
  const updateKeybindings = usePreferences((s) => s.updateKeybindings);
  const resetKeybindings = usePreferences((s) => s.resetKeybindings);
  const [capturingId, setCapturingId] = useState<ActionId | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Clearing the map is what "default" means — writing every default
            // back explicitly would leave `keybindings` full of entries that
            // aren't overrides at all.
            resetKeybindings();
            setCapturingId(null);
            setConflictMsg(null);
          }}
        >
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>
      <div className="space-y-1">
        {ACTIONS.map((action) => {
          const bindings = userBindings(keybindings, action.id);
          return (
            <ShortcutRow
              key={action.id}
              action={action}
              bindings={bindings}
              isDefault={keybindings[action.id] === undefined}
              isCapturing={capturingId === action.id}
              conflictMsg={capturingId === action.id ? conflictMsg : null}
              onStartCapture={() => {
                setCapturingId(action.id);
                setConflictMsg(null);
              }}
              onCancelCapture={() => setCapturingId(null)}
              onCaptured={(next) => {
                // Only bindings whose scope can actually be heard at the same
                // time as this action's are a conflict; `grid` and `editor` may
                // share a key without either of them ever being ambiguous.
                const clashes = findConflicts(keybindings, action.id, next);
                if (clashes.length > 0) {
                  setConflictMsg(
                    t("settings.shortcuts.conflict", {
                      action: t(
                        ACTIONS.find((a) => a.id === clashes[0].actionId)?.labelKey ??
                          clashes[0].actionId,
                      ),
                    }),
                  );
                  return;
                }
                updateKeybindings({ [action.id]: [next] });
                setCapturingId(null);
              }}
              onReset={() => updateKeybindings({ [action.id]: undefined })}
            />
          );
        })}
      </div>
    </div>
  );
}
