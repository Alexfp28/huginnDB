/**
 * The "this connection is no longer published by its origin" notice (#108),
 * and the two actions that resolve it.
 *
 * Why a banner and not a dialog: the sweep that raises these runs in the
 * background (`stores/originSync.ts`), so there is nobody guaranteed to be
 * watching when it lands. A modal — or worse, a `window.confirm` — fired from a
 * timer steals the keystroke of whoever is mid-query. The notice therefore sits
 * in the tree and waits, exactly like `connectionHealth`'s lost-pool indicator.
 *
 * Neither action is implicit. The backend only ever *reports* a disappearance:
 * another user editing the shared file must never be able to destroy local
 * credentials, so `retire` is the user's own deletion (confirmed via
 * `confirmIrreversible`, ignoring the "confirm destructive" preference — the
 * keychain entry does not come back).
 *
 * Two surfaces, because a vanished connection may be idle and therefore absent
 * from the tree entirely:
 *
 * * [[VanishedOriginNotice]] — the full banner. Tree + Settings → Origins.
 * * [[VanishedOriginMark]] — an icon and a tooltip, for dense rows
 *   (the status-bar dropdown) whose job is only to point at the banner.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Trash2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useConnections } from "@/stores/session/connections";
import { useOriginSync } from "@/stores/sync/originSync";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";

/** Full notice with both actions. Renders nothing when there is no notice. */
export function VanishedOriginNotice({
  profileId,
  className,
  showConnection = false,
}: {
  profileId: string;
  className?: string;
  /**
   * Name the connection in the title. Off in the tree, where the connection is
   * whichever one is selected and repeating its name is noise; on in Settings,
   * where several notices can stack and only the name tells them apart.
   */
  showConnection?: boolean;
}) {
  const { t } = useTranslation();
  // Selector returns the stored object (or undefined) rather than deriving a
  // new one, so it stays reference-stable between syncs (gotcha #1).
  const notice = useOriginSync((s) => s.vanished[profileId]);
  const adopt = useOriginSync((s) => s.adopt);
  const retire = useOriginSync((s) => s.retire);
  const name = useConnections(
    (s) => s.profiles.find((p) => p.id === profileId)?.name,
  );
  const [busy, setBusy] = useState(false);

  if (!notice) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      // Leave the notice standing: the decision was not recorded, so the user
      // can retry. Failing silently would look like the click did nothing.
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "m-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {/* Light-theme contrast: amber-500 on a pale wash is too faint, so the
            icon follows the same 600/500 split McpSection uses. */}
        <Unlink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">
            {showConnection && name
              ? t("origins.vanished.titleNamed", { name })
              : t("origins.vanished.title")}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t("origins.vanished.body", { origin: notice.originName })}
          </p>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          disabled={busy}
          title={t("origins.vanished.keepTooltip")}
          className="flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
          onClick={() => void run(() => adopt(profileId))}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t("origins.vanished.keep")}
        </button>
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
          onClick={() => {
            if (
              !confirmIrreversible(
                t("origins.vanished.retireConfirm", { name: name ?? profileId }),
              )
            ) {
              return;
            }
            void run(() => retire(profileId));
          }}
        >
          <Trash2 className="h-3 w-3" />
          {t("origins.vanished.retire")}
        </button>
      </div>
    </div>
  );
}

/**
 * Compact marker for rows too dense for the banner. Deliberately has no
 * actions: two labelled buttons don't fit in a dropdown row, and duplicating a
 * destructive affordance into a menu the user is scrolling past is how accidents
 * happen. It points at the banner instead.
 *
 * Native `title` rather than `SimpleTooltip` on purpose — every current call
 * site is inside open menu content, where a Radix tooltip fights the menu's own
 * hover/portal handling (see the note on `SimpleTooltip`).
 */
export function VanishedOriginMark({ profileId }: { profileId: string }) {
  const { t } = useTranslation();
  const notice = useOriginSync((s) => s.vanished[profileId]);

  if (!notice) return null;

  return (
    <span
      className="flex shrink-0 items-center"
      title={t("origins.vanished.mark", { origin: notice.originName })}
    >
      <Unlink className="h-3 w-3 text-amber-600 dark:text-amber-500" />
    </span>
  );
}
