/**
 * The one bar at the top of every window: HuginnDB's own chrome and the OS
 * window controls in a single 36px row, the way Claude Desktop or VS Code do
 * it, instead of the native title bar stacked on top of the app's menu bar.
 *
 * The native frame is turned off in the backend (`window_chrome.rs`), so
 * everything the title bar used to give for free is rebuilt here:
 *
 * - **Dragging.** `data-tauri-drag-region` on the `<header>`. Tauri only starts
 *   a drag when the pointer lands on the element *carrying* the attribute, not
 *   on its descendants, so empty stretches of the bar drag and buttons stay
 *   clickable without any per-child opt-out. That is also why a caller's
 *   decorative content (the breadcrumb, a window title) must be
 *   `pointer-events-none`: the press then falls through to the header. A
 *   double-click on the same region toggles maximise — Tauri's drag script
 *   handles that too (`core:window:allow-internal-toggle-maximize`).
 * - **Minimise / maximise / close.** `WindowControls` below. `close()` raises
 *   `CloseRequested` exactly like the native ✕ did, so the main window's
 *   flush-before-exit in `App.tsx` still runs.
 * - **Resizing** needs nothing here: an undecorated Windows window keeps its
 *   DWM shadow, and the resize borders live in it, outside the client area.
 *
 * No Snap Layouts flyout on hover over maximise: Windows only draws it for a
 * button it recognises as its own, which a button inside a webview is not.
 * The one plugin that claims it (`tauri-plugin-decorum`) fakes it by typing
 * Win+Z and then Alt through `SendInput`, which we declined. Win+Z, Win+arrows
 * and dragging to the top of the screen still snap as usual.
 *
 * macOS keeps its native frame (`usesNativeFrame`): its traffic lights sit on
 * the left, the platform is unverified here, and a half-done overlay is worse
 * than the bar it replaced. There the component is just the app's menu bar.
 */

import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Whether this platform keeps the OS title bar — see the header comment.
 *  Mirrors `window_chrome::uses_native_frame` on the Rust side. */
export function usesNativeFrame(): boolean {
  return isMac();
}

export function TitleBar({ children }: { children: ReactNode }) {
  const native = usesNativeFrame();
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 select-none items-center border-b border-border pl-2"
    >
      {!native && (
        <img
          src="/image/huginn-mark-128.png"
          alt=""
          aria-hidden
          draggable={false}
          // Part of the drag surface, like the empty bar around it.
          data-tauri-drag-region
          className="mr-1.5 h-4 w-4 shrink-0"
        />
      )}
      {children}
      {native ? <span className="w-2 shrink-0" /> : <WindowControls />}
    </header>
  );
}

/**
 * The window's own title as the bar's centred text, for the windows that have
 * no menus of their own (a floating tab, Pulse) and would otherwise show an
 * empty strip where the native caption used to name them. Read once: both get
 * their title at creation (`open_tab_window` / `open_pulse_window`) and never
 * change it. The horizontal padding keeps a long title clear of the caption
 * buttons on the right, and the same on the left so it stays centred.
 */
export function WindowCaption() {
  const [title, setTitle] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getCurrentWindow()
      .title()
      .then((value) => {
        if (!cancelled) setTitle(value);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-36">
      <span className="truncate text-xs text-muted-foreground">{title}</span>
    </div>
  );
}

/** Tracks the window's maximised state so the middle button can swap between
 *  the maximise and restore glyphs, the way the native one does. Every resize
 *  re-asks rather than toggling a local flag: maximising also happens from a
 *  double-click on the bar, Win+↑ or a snap, none of which pass through here. */
function useIsMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      });
    sync();
    void win.onResized(sync).then((fn) => {
      // Unmounted before the listener was registered: drop it straight away.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return maximized;
}

function WindowControls() {
  const { t } = useTranslation();
  const maximized = useIsMaximized();
  const win = getCurrentWindow();
  return (
    <div className="ml-1 flex self-stretch">
      <CaptionButton
        label={t("shell.windowControls.minimize")}
        onClick={() => void win.minimize()}
      >
        <path d="M0 5.5H10" />
      </CaptionButton>
      <CaptionButton
        label={t(
          maximized
            ? "shell.windowControls.restore"
            : "shell.windowControls.maximize",
        )}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? (
          <path d="M0.5 2.5H7.5V9.5H0.5Z M2.5 2.5V0.5H9.5V7.5H7.5" />
        ) : (
          <path d="M0.5 0.5H9.5V9.5H0.5Z" />
        )}
      </CaptionButton>
      <CaptionButton
        close
        label={t("shell.windowControls.close")}
        onClick={() => void win.close()}
      >
        <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
      </CaptionButton>
    </div>
  );
}

/**
 * One caption button: Windows' 46px-wide, full-height, square-cornered shape
 * with a 10px hairline glyph, rather than a 28px `IconButton` — these are the
 * OS's controls and should read as such, down to the red close hover
 * (`#c42b1c`, the colour Windows 11 itself uses, on purpose not the theme's
 * `destructive`, which an imported theme can make any colour at all).
 *
 * No tooltip, like the native ones, but an `aria-label` for the name.
 */
function CaptionButton({
  label,
  close = false,
  onClick,
  children,
}: {
  label: string;
  close?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      flat
      size="xs"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "h-full w-[46px] rounded-none px-0 active:scale-100",
        close && "hover:bg-[#c42b1c] hover:text-white",
      )}
    >
      <svg
        aria-hidden
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        // Axis-aligned glyphs land on whole pixels; the close cross is
        // diagonal and would only get jagged.
        shapeRendering={close ? "geometricPrecision" : "crispEdges"}
      >
        {children}
      </svg>
    </Button>
  );
}
