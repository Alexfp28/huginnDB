/**
 * Top-bar "Window" dropdown — window/layout-level actions that don't fit
 * under File (connections) or View (panel visibility): opening a new OS
 * window, and resetting the outer dockview layout back to its default.
 */

import { AppWindow, ChevronDown, LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resetLayout } from "@/lib/dockview";
import { api } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";

export function WindowMenu() {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <AppWindow className="h-3.5 w-3.5" />
          {t("menu.window.label")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onSelect={() => {
            void api.openNewWindow().catch((err) => {
              console.error("[window] failed to open new window:", err);
            });
          }}
        >
          <AppWindow className="mr-2 h-3.5 w-3.5" />
          {t("menu.window.newWindow")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={resetLayout} className="text-xs">
          <LayoutGrid className="mr-2 h-3.5 w-3.5" />
          {t("menu.window.resetLayout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
