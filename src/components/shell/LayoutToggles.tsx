/**
 * VSCode-style "toggle sidebar/panel" buttons — Schema (left), Console
 * (bottom), Saved (right). Lives in the header's top-right corner, the slot
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
  const savedOpen = useSessionPanelLayout((s) => s.savedOpen);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  const toggleSaved = useSessionPanelLayout((s) => s.toggleSaved);

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
        label={t("panels.saved")}
        active={savedOpen}
        onClick={toggleSaved}
      />
    </div>
  );
}
