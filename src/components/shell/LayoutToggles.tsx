/**
 * VSCode-style "toggle sidebar/panel" buttons — Schema (left), Console
 * (bottom), right dock (right). Each one toggles an *edge*, not a specific
 * panel: the right button shows or hides the dock and leaves the choice of
 * which panel occupies it to the activity bar (see `panelLayout.ts`).
 * Lives in the header's top-right corner, the slot
 * Theme/Settings vacated when they moved into the left rail's footer (see
 * `AppShell`'s `ChromeFooter`) — chrome-level display toggles belong with
 * the rest of the "what's visible" controls, not buried in a menu.
 *
 * Each icon is the matching lucide `Panel{Left,Bottom,Right}` glyph — a
 * rectangle with the relevant edge highlighted — active state is a filled
 * background, exactly the same on/off language `ActivityBar` buttons use.
 */

import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function ToggleButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof PanelLeft;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip label={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:bg-foreground/[0.06] hover:text-foreground",
          active && "bg-foreground/[0.08] text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </button>
    </SimpleTooltip>
  );
}

export function LayoutToggles() {
  const { t } = useTranslation();
  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const consoleOpen = useSessionPanelLayout((s) => s.consoleOpen);
  const rightPanel = useSessionPanelLayout((s) => s.rightPanel);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  const toggleRightDock = useSessionPanelLayout((s) => s.toggleRightDock);

  return (
    <div className="flex items-center gap-0.5">
      <ToggleButton
        icon={PanelLeft}
        label={t("panels.schema")}
        active={schemaOpen}
        onClick={toggleSchema}
      />
      <ToggleButton
        icon={PanelBottom}
        label={t("panels.console")}
        active={consoleOpen}
        onClick={toggleConsole}
      />
      <ToggleButton
        icon={PanelRight}
        label={t("panels.rightDock")}
        active={rightPanel !== null}
        onClick={toggleRightDock}
      />
    </div>
  );
}
