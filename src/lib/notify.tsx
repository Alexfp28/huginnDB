/**
 * Raising a notification. The one entry point — nothing outside this module
 * imports `sonner` any more.
 *
 * The split is deliberate: **Sonner is the transport, the card is ours.** It
 * keeps the stack (positions, gaps, swipe, focus, timers) and, because a `jsx`
 * toast is flagged `data-styled="false"`, paints none of it — so
 * `NotificationCard` owns the surface and the ~60 lines of `!important` that
 * used to fight the library's hardcoded white card are gone. Sonner already
 * takes `position`, `duration`, `visibleToasts`, `expand`, `gap` and `offset`
 * as props, which is what makes the whole "disposición" half of the
 * preferences section configuration rather than a second toast host.
 *
 * Three behaviours live here rather than at the call sites, because they are
 * policy and not decoration:
 *
 * * **Duration.** The base is `notifications.durationMs` (6 s, up from the
 *   library's 4 s, which was not long enough to read a path or a driver error).
 *   Kinds that carry something to act on get a multiple of it, and an error
 *   waits to be dismissed when `errorsPersist` is on.
 * * **Grouping.** A burst of identical notifications — a multi-row save, a
 *   loop — is one card with a counter instead of seven cards. The key defaults
 *   to kind + title, so no call site had to opt in.
 * * **History.** Every notification is recorded for the bell
 *   (`stores/notifications.ts`) as it is raised. That is what makes short
 *   toasts acceptable: nothing is lost by missing one.
 *
 * Grouping state lives *here* and the store only records the decision, so the
 * screen and the history can never disagree about what counts as a repeat.
 */

import { create } from "zustand";
import { toast } from "sonner";
import { NotificationCard } from "@/components/shell/NotificationCard";
import type { NotificationAction } from "@/components/shell/NotificationCard";
import { copyToClipboard } from "@/lib/grid/clipboard";
import { baseName } from "@/lib/filePath";
import i18n from "@/lib/i18n";
import { usePreferences } from "@/stores/preferences/preferences";
import { useNotifications } from "@/stores/notifications";
import type { NotificationKind } from "@/stores/notifications";

export interface NotifyOptions {
  /** The second line: a count, a reason, a raw driver message. */
  description?: string;
  /** Render the description monospaced. Implied for `error`. */
  mono?: boolean;
  /** Extra buttons. At most one should be `primary`. */
  actions?: NotificationAction[];
  /**
   * Override the lifetime in ms. `0` pins the card until it is dismissed.
   * Prefer letting the preference decide.
   */
  durationMs?: number;
  /**
   * Identity for folding repeats together. Defaults to `kind:title`; pass a
   * string to group notifications whose titles differ (per table, per file), or
   * `false` when every occurrence genuinely deserves its own card.
   */
  group?: string | false;
}

export interface NotifyFileOptions extends NotifyOptions {
  /** Absolute path of the file that was just written. */
  path: string;
  /** Human-readable size, when the caller knows it. */
  size?: string;
}

/**
 * How long each kind lives, as a multiple of the configured duration.
 *
 * A confirmation only has to be noticed, so it takes the base. A warning and an
 * error have to be *read*. A file notification has to be acted on — the whole
 * point is clicking through to the file — so it gets the longest run, capped so
 * it cannot sit there for a minute because someone set a long base duration.
 */
const KIND_FACTOR: Record<NotificationKind, number> = {
  success: 1,
  info: 1,
  warning: 2,
  error: 2,
  file: 4,
};

/** Ceiling for the multiplied lifetime. The user's own value is never capped. */
const MAX_KIND_DURATION_MS = 30_000;

/** Bounds for the configured duration; `0` (sticky) bypasses them. */
export const MIN_DURATION_MS = 1_500;
export const MAX_DURATION_MS = 60_000;

/** How long a group keeps absorbing repeats after the last one. */
const GROUP_WINDOW_MS = 5_000;

interface LiveGroup {
  toastId: string;
  historyId: string;
  count: number;
  /** Unix ms of the most recent occurrence. */
  at: number;
}

const groups = new Map<string, LiveGroup>();

let seq = 0;

/** Clamp a configured duration; `0` means "until dismissed" and passes through. */
function clampDuration(ms: number): number {
  if (ms <= 0) return 0;
  return Math.min(Math.max(ms, MIN_DURATION_MS), MAX_DURATION_MS);
}

/**
 * A live ordered mirror of the on-screen stack — newest first, exactly like
 * Sonner's own internal array — used for two things Sonner has no concept
 * of: protecting a card from being pushed behind `maxVisible` (see
 * {@link protectStackBoundary}) and driving the "+N more" pill
 * (`NotificationOverflowPill`), since Sonner does not expose how many toasts
 * it stopped rendering.
 *
 * A "progress" entry is tracked here too even though it is not a
 * {@link NotificationKind} — see {@link raise}'s `forceToastId` branch, which
 * relabels it in place once it resolves.
 */
interface ToastStackState {
  entries: { id: string; kind: NotificationKind | "progress" }[];
  push: (id: string, kind: NotificationKind | "progress") => void;
  remove: (id: string) => void;
  setKind: (id: string, kind: NotificationKind) => void;
}

/** Exported only so tests can reset it between cases — module state, like
 *  `groups`, otherwise outlives any single test in the same file. */
export const useToastStack = create<ToastStackState>()((set) => ({
  entries: [],
  push(id, kind) {
    set((s) => ({ entries: [{ id, kind }, ...s.entries] }));
  },
  remove(id) {
    set((s) =>
      s.entries.some((e) => e.id === id)
        ? { entries: s.entries.filter((e) => e.id !== id) }
        : s,
    );
  },
  setKind(id, kind) {
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, kind } : e)) }));
  },
}));

/**
 * Kinds a stack-boundary crossing must never bump behind `maxVisible`: an
 * error nobody has read yet, and a progress bar that is still running.
 */
const PROTECTED_STACK_KINDS = new Set<NotificationKind | "progress">(["error", "progress"]);

/**
 * Called right before a brand-new card takes a stack slot. Sonner unshifts
 * every new toast to the front and everything else shifts one slot back —
 * the entry that was at the last visible slot (`maxVisible - 1`) falls
 * behind the fold. If that entry is protected, dismiss the nearest
 * unprotected one in front of it instead, so the count entering this
 * function still nets to "one slot freed" but the protected card keeps its
 * place. Removal from `entries` is optimistic (not deferred to the toast's
 * own `onDismiss`) so the very next call sees the corrected count even
 * though Sonner's own removal animates.
 */
function protectStackBoundary(maxVisible: number) {
  if (maxVisible <= 0) return;
  const entries = useToastStack.getState().entries;
  if (entries.length < maxVisible) return;
  const boundary = entries[maxVisible - 1];
  if (!boundary || !PROTECTED_STACK_KINDS.has(boundary.kind)) return;
  for (let i = maxVisible - 2; i >= 0; i--) {
    if (!PROTECTED_STACK_KINDS.has(entries[i].kind)) {
      toast.dismiss(entries[i].id);
      useToastStack.getState().remove(entries[i].id);
      return;
    }
  }
  // Every visible slot is protected (all errors/progress) — nothing safe to
  // evict instead, so the natural Sonner behaviour applies this once.
}

/**
 * How many active notifications are currently pushed behind `maxVisible` —
 * the count the "+N more" pill (`NotificationOverflowPill`) renders.
 *
 * `entries` is the raw store array (stable unless the stack actually
 * changes), and the subtraction is cheap arithmetic done at render time, not
 * a selector return — so this stays clear of the infinite-re-render trap in
 * CLAUDE.md gotcha #1.
 */
export function useHiddenToastCount(): number {
  const entries = useToastStack((s) => s.entries);
  const maxVisible = usePreferences((s) => s.prefs.notifications.maxVisible);
  return Math.max(0, entries.length - maxVisible);
}

function raise(
  kind: NotificationKind,
  title: string,
  opts: NotifyOptions & { path?: string; size?: string } = {},
  /**
   * Resolve an existing card in place instead of raising a new one — how a
   * `notify.progress()` handle turns its bar into success/error/file. The
   * slot already exists (and was already protected from eviction when the
   * progress bar first appeared), so this only relabels it.
   */
  forceToastId?: string,
) {
  const prefs = usePreferences.getState().prefs.notifications;
  const base = clampDuration(prefs.durationMs);

  // An error that waits to be dismissed is the default: it usually carries
  // something to copy, retry or report, and none of that happens in six
  // seconds. An explicit `durationMs: 0` pins any kind.
  const persistent =
    opts.durationMs === 0 || base === 0 || (kind === "error" && prefs.errorsPersist);
  const durationMs = persistent
    ? 0
    : Math.min(
        opts.durationMs ?? Math.round(base * KIND_FACTOR[kind]),
        Math.max(base, MAX_KIND_DURATION_MS),
      );

  const file = opts.path
    ? { path: opts.path, name: baseName(opts.path), size: opts.size }
    : undefined;
  const mono = opts.mono ?? kind === "error";

  const groupKey = opts.group === false ? null : (opts.group ?? `${kind}:${title}`);
  const now = Date.now();
  const live = groupKey ? groups.get(groupKey) : undefined;
  const grouped = live && now - live.at <= GROUP_WINDOW_MS ? live : undefined;

  const count = grouped ? grouped.count + 1 : 1;
  const history = useNotifications.getState();
  const record = () =>
    history.push({ kind, title, description: opts.description, mono, file });
  // A group can outlive its history entry — the user cleared the panel, or the
  // cap evicted it — in which case the repeat is recorded afresh rather than
  // written into an entry that is no longer there.
  const historyId = grouped
    ? history.bump(grouped.historyId, {
        count,
        title,
        description: opts.description,
        file,
      })
      ? grouped.historyId
      : record()
    : record();

  const toastId = forceToastId ?? (grouped ? grouped.toastId : `notif-${++seq}`);
  if (groupKey) groups.set(groupKey, { toastId, historyId, count, at: now });

  if (forceToastId) {
    // Relabelling a progress bar's slot in place — it already occupies a
    // stack position (and already went through the eviction guard once).
    useToastStack.getState().setKind(forceToastId, kind);
  } else if (!grouped) {
    protectStackBoundary(prefs.maxVisible);
    useToastStack.getState().push(toastId, kind);
  }

  // An error carries a message worth keeping even when nothing can be retried,
  // and copying it needs no context from the call site — so it is the one
  // action added for free.
  const actions: NotificationAction[] = [...(opts.actions ?? [])];
  if (kind === "error" && !actions.length) {
    actions.push({
      label: i18n.t("notifications.copyError"),
      onClick: () =>
        void copyToClipboard([title, opts.description].filter(Boolean).join("\n")),
      dismiss: false,
    });
  }

  toast.custom(
    (id) => (
      <NotificationCard
        kind={kind}
        title={title}
        description={opts.description}
        mono={mono}
        count={count}
        file={file}
        actions={actions}
        durationMs={durationMs || undefined}
        density={prefs.density}
        onDismiss={() => toast.dismiss(id)}
        onFileMissing={() => useNotifications.getState().markMissing(historyId)}
      />
    ),
    {
      id: toastId,
      // Sonner special-cases `Infinity` and skips the timer entirely.
      duration: durationMs || Infinity,
      // Whether it timed out or was swiped away, the group is over: the next
      // identical notification starts a fresh card rather than resurrecting
      // this one's counter.
      onAutoClose: () => {
        if (groupKey) groups.delete(groupKey);
        useToastStack.getState().remove(toastId);
      },
      onDismiss: () => {
        if (groupKey) groups.delete(groupKey);
        useToastStack.getState().remove(toastId);
      },
    },
  );

  return toastId;
}

export interface ProgressUpdate {
  done: number;
  total: number;
}

export interface NotifyProgressOptions {
  /** Static second line while no numbers have arrived yet. */
  description?: string;
  /** Formats the second line once numbers are known; overrides `description`. */
  formatProgress?: (p: ProgressUpdate) => string;
}

export interface ProgressHandle {
  /** Push a done/total tick. A card with no `formatProgress` just fills the bar. */
  update: (p: ProgressUpdate) => void;
  /** Resolve into a normal card, in the same slot, recorded in history for the
   *  first time — the history never carries an "Importando…" placeholder. */
  success: (title: string, opts?: NotifyOptions) => void;
  error: (title: string, opts?: NotifyOptions) => void;
  file: (title: string, opts: NotifyFileOptions) => void;
  /** Withdraw without recording anything — nothing worth telling happened. */
  dismiss: () => void;
}

function renderProgressCard(
  toastId: string,
  title: string,
  description: string | undefined,
  progress: ProgressUpdate | undefined,
) {
  const density = usePreferences.getState().prefs.notifications.density;
  toast.custom(
    () => (
      <NotificationCard
        kind="progress"
        title={title}
        description={description}
        progress={progress}
        density={density}
        // Not dismissible while running (see the toast option below); the
        // card renders no close button for this kind, so this is never called.
        onDismiss={() => {}}
      />
    ),
    {
      id: toastId,
      duration: Infinity,
      dismissible: false,
    },
  );
}

/**
 * A long-running task with a determinate outcome, reported the same way a
 * normal notification is — the card just starts as a spinner/bar and morphs
 * into success/error/file in place once the handle is told how it ended.
 *
 * Deliberately outside `raise()`'s grouping: two concurrent progress bars are
 * two cards, never one with a counter (`group: false` is implicit here, not
 * a caller option), which is also why resolving always passes it through to
 * `raise` explicitly rather than trusting a default.
 */
function progress(title: string, opts: NotifyProgressOptions = {}): ProgressHandle {
  const toastId = `notif-${++seq}`;
  const prefs = usePreferences.getState().prefs.notifications;
  let settled = false;

  protectStackBoundary(prefs.maxVisible);
  useToastStack.getState().push(toastId, "progress");
  renderProgressCard(toastId, title, opts.description, undefined);

  return {
    update(p) {
      if (settled) return;
      renderProgressCard(
        toastId,
        title,
        opts.formatProgress ? opts.formatProgress(p) : opts.description,
        p,
      );
    },
    success: (t, o) => {
      if (settled) return;
      settled = true;
      raise("success", t, { ...o, group: false }, toastId);
    },
    error: (t, o) => {
      if (settled) return;
      settled = true;
      raise("error", t, { ...o, group: false }, toastId);
    },
    file: (t, o) => {
      if (settled) return;
      settled = true;
      raise("file", t, { ...o, group: false }, toastId);
    },
    dismiss: () => {
      if (settled) return;
      settled = true;
      useToastStack.getState().remove(toastId);
      toast.dismiss(toastId);
    },
  };
}

export const notify = {
  /** Something the user asked for happened. The 80 % case. */
  success: (title: string, opts?: NotifyOptions) => raise("success", title, opts),
  /** Something failed. Persistent by default, with a copy action. */
  error: (title: string, opts?: NotifyOptions) => raise("error", title, opts),
  /** It worked, but not entirely — partial imports, skipped rows. */
  warning: (title: string, opts?: NotifyOptions) => raise("warning", title, opts),
  /** The app reporting a state change nobody asked for. */
  info: (title: string, opts?: NotifyOptions) => raise("info", title, opts),
  /**
   * A file was written. The name becomes a control that reveals it in the OS
   * file manager — the reason this kind exists rather than being a `success`
   * with the path glued into the sentence.
   */
  file: (title: string, opts: NotifyFileOptions) => raise("file", title, opts),
  /**
   * A long-running task reported live — a spinner or determinate bar that
   * turns into success/error/file in the same card once it's told the
   * outcome. See {@link ProgressHandle}.
   */
  progress,
  /** Dismiss one notification, or every one when called bare. */
  dismiss: (id?: string) => toast.dismiss(id),
};
