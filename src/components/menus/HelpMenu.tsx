/**
 * Top-bar "Help" dropdown — the in-app issue reporter and About, both
 * previously buried at the bottom of File / reachable only via the gear
 * icon.
 */

import {
  BookOpen,
  CircleHelp,
  ChevronDown,
  Info,
  MessageSquarePlus,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { useFeedbackDialog } from "@/stores/feedbackDialog";
import { useWhatsNew } from "@/stores/whatsNew";
import { useDocsDialog } from "@/stores/docsDialog";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";

export function HelpMenu() {
  const openSettings = useSettingsDialog((s) => s.openAt);
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <CircleHelp className="h-3.5 w-3.5" />
          {t("menu.help.label")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onSelect={() => useWhatsNew.getState().openLatest()}
          className="text-xs"
        >
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          {t("whatsNew.menuEntry")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => useDocsDialog.getState().openTo()}
          className="text-xs"
        >
          <BookOpen className="mr-2 h-3.5 w-3.5" />
          {t("docs.menuEntry")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => useFeedbackDialog.getState().openWith()}
          className="text-xs"
        >
          <MessageSquarePlus className="mr-2 h-3.5 w-3.5" />
          {t("feedback.menuEntry")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("about")} className="text-xs">
          <Info className="mr-2 h-3.5 w-3.5" />
          {t("menu.help.about")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
