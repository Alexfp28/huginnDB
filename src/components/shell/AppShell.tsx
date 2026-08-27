/**
 * Root layout of the outer shell: the environment rail (left), two
 * collapsible side panels (Schema, Saved), the workspace island, and a
 * bottom console dock.
 *
 * Replaces the old outer `DockviewReact` (5 equal-rank panels — see
 * `stores/session/panelLayout.ts` for why). Fixed roles instead of
 * draggable/floatable panels: nothing here can be reordered or torn off,
 * which is the whole point — the previous layout visually implied you
 * could spin up more "workspaces", and this one can't.
 *
 * The left rail is `EnvironmentRail` (Discord-style environment icons),
 * not a generic `ActivityBar` — there is no separate "Schema" toggle
 * button; clicking the already-active environment's icon collapses/
 * expands the Schema panel instead. The right side keeps the generic
 * `ActivityBar` for Saved, since it isn't tied to any per-environment
 * identity.
 *
 * `TabbedArea` (nested dockview, gotcha #10) lives untouched inside
 * `IslandShell`; nothing in this file talks to dockview at all.
 */

import { useState } from "react";
import { Moon, Save, Settings, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUi } from "@/stores/session/ui";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useThemeStore, selectActiveMode } from "@/stores/preferences/theme";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { ConnectionsTree } from "@/components/connection/ConnectionsTree";
import { SavedQueriesPanel } from "@/components/query/SavedQueriesPanel";
import { ConnectionErrorBoundary } from "@/components/connection/ConnectionErrorBoundary";
import { EnvironmentRail } from "@/components/connection/EnvironmentRail";
import {
  ActivityBar,
  type ActivityBarButton,
} from "@/components/shell/ActivityBar";
import { IslandShell } from "@/components/shell/IslandShell";
import { ConsoleDock } from "@/components/shell/ConsoleDock";
import { CollapsiblePanel } from "@/components/shell/CollapsiblePanel";
import { Sash } from "@/components/shell/Sash";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function SchemaPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return (
    <ConnectionErrorBoundary resetKey={id ?? undefined}>
      <ConnectionsTree />
    </ConnectionErrorBoundary>
  );
}

function SavedPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return <SavedQueriesPanel connectionId={id} />;
}

/**
 * Theme + Settings buttons, moved here from the top header (they used to
 * sit at its far right) into the left activity bar's footer — the user
 * asked for chrome-level actions to live with the rest of the shell
 * chrome instead of the header, which now only carries the menu bar and
 * the breadcrumb.
 */
function ChromeFooter() {
  const { t } = useTranslation();
  const mode = useThemeStore(selectActiveMode);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const updateNotificationVisible = useUpdateStore(
    selectUpdateNotificationVisible,
  );
  const availableVersion = useUpdateStore((s) => s.availableVersion);

  return (
    <>
      <SimpleTooltip label={t("common.tooltipToggleTheme")} side="right">
        <button
          type="button"
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {mode === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </button>
      </SimpleTooltip>
      <SimpleTooltip
        side="right"
        label={
          updateNotificationVisible
            ? t("update.tooltipUpdateAvailable", { version: availableVersion })
            : t("common.tooltipOpenPreferences")
        }
      >
        <button
          type="button"
          onClick={() =>
            updateNotificationVisible ? openSettings("about") : openSettings()
          }
          className="relative mt-1 flex h-9 w-9 items-center justify-center rounded-[10px] text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <Settings className="h-5 w-5" />
          {updateNotificationVisible && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-background",
              )}
            />
          )}
        </button>
      </SimpleTooltip>
    </>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const selectedConnectionId = useUi((s) => s.selectedConnectionId);

  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const schemaWidth = useSessionPanelLayout((s) => s.schemaWidth);
  const savedOpen = useSessionPanelLayout((s) => s.savedOpen);
  const savedWidth = useSessionPanelLayout((s) => s.savedWidth);
  const toggleSaved = useSessionPanelLayout((s) => s.toggleSaved);
  const setSchemaWidth = useSessionPanelLayout((s) => s.setSchemaWidth);
  const setSavedWidth = useSessionPanelLayout((s) => s.setSavedWidth);
  const [schemaDragging, setSchemaDragging] = useState(false);
  const [savedDragging, setSavedDragging] = useState(false);

  const rightButtons: ActivityBarButton[] = [
    {
      id: "saved",
      icon: Save,
      label: t("panels.saved"),
      active: savedOpen,
      onClick: toggleSaved,
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-muted/40">
      <EnvironmentRail footer={<ChromeFooter />} />

      <CollapsiblePanel
        open={schemaOpen}
        size={schemaWidth}
        axis="width"
        dragging={schemaDragging}
      >
        <div className="h-full overflow-hidden py-2 pl-2">
          <div className="h-full overflow-hidden rounded-[var(--radius)] border border-border bg-background shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_4%,transparent),0_6px_20px_color-mix(in_srgb,var(--foreground)_5%,transparent)]">
            <SchemaPanel />
          </div>
        </div>
      </CollapsiblePanel>
      {schemaOpen && (
        <Sash
          orientation="vertical"
          onResize={(delta) => setSchemaWidth(schemaWidth + delta)}
          onDraggingChange={setSchemaDragging}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2">
        <IslandShell connectionId={selectedConnectionId} />
        <ConsoleDock />
      </div>

      {savedOpen && (
        <Sash
          orientation="vertical"
          onResize={(delta) => setSavedWidth(savedWidth - delta)}
          onDraggingChange={setSavedDragging}
        />
      )}
      <CollapsiblePanel
        open={savedOpen}
        size={savedWidth}
        axis="width"
        dragging={savedDragging}
      >
        <div className="h-full overflow-hidden py-2 pr-2">
          <div className="h-full overflow-hidden rounded-[var(--radius)] border border-border bg-background shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_4%,transparent),0_6px_20px_color-mix(in_srgb,var(--foreground)_5%,transparent)]">
            <SavedPanel />
          </div>
        </div>
      </CollapsiblePanel>

      <ActivityBar side="right" buttons={rightButtons} />
    </div>
  );
}
