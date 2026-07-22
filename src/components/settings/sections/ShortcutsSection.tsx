/**
 * Editable keyboard-shortcut list (issue #75). Each row can be rebound by
 * clicking it and pressing a new combo; conflicts with another action's
 * binding block the save and surface an inline error instead of silently
 * swapping or unbinding anything.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePreferences, selectKeybindings } from "@/stores/preferences";
import { ACTIONS, getBinding, type ActionId } from "@/lib/keybindings";
import { ShortcutRow } from "./ShortcutRow";

export function ShortcutsSection() {
  const { t } = useTranslation();
  const keybindings = usePreferences(selectKeybindings);
  const updateKeybindings = usePreferences((s) => s.updateKeybindings);
  const [capturingId, setCapturingId] = useState<ActionId | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            updateKeybindings(
              Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaultCombo])),
            );
            setCapturingId(null);
          }}
        >
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>
      <div className="space-y-1">
        {ACTIONS.map((action) => {
          const combo = getBinding(keybindings, action.id);
          return (
            <ShortcutRow
              key={action.id}
              action={action}
              combo={combo}
              isDefault={combo === action.defaultCombo}
              isCapturing={capturingId === action.id}
              conflictMsg={capturingId === action.id ? conflictMsg : null}
              onStartCapture={() => {
                setCapturingId(action.id);
                setConflictMsg(null);
              }}
              onCancelCapture={() => setCapturingId(null)}
              onCaptured={(next) => {
                const conflict = ACTIONS.find(
                  (a) =>
                    a.id !== action.id && getBinding(keybindings, a.id) === next,
                );
                if (conflict) {
                  setConflictMsg(
                    t("settings.shortcuts.conflict", {
                      action: t(conflict.labelKey),
                    }),
                  );
                  return;
                }
                updateKeybindings({ [action.id]: next });
                setCapturingId(null);
              }}
              onReset={() => updateKeybindings({ [action.id]: action.defaultCombo })}
            />
          );
        })}
      </div>
    </div>
  );
}
