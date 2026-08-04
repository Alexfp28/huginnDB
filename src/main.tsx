import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { DetachedTabWindow } from "./components/shell/DetachedTabWindow";
import "./lib/monaco/monaco-setup";
import "./lib/i18n";
import "./index.css";

// The WebView's native context menu (Reload, View source, Inspect…) has no
// Tauri config flag to disable it — every custom right-click menu in the app
// is a Radix `ContextMenu` that already calls its own `preventDefault` on its
// trigger, so this only ever suppresses the native one on the areas that
// don't have a custom menu of their own (blank tree space, the row-number
// column, …). Left enabled in dev so `pnpm tauri:dev` still gets the
// WebView2 inspector via right-click.
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

// A "sacar como ventana flotante" window (see `open_tab_window` /
// `TabbedArea`'s floatPanel action) is labeled "tabwin-<uuid>" and renders a
// single bare tab instead of the full app shell.
const isDetachedTabWindow = getCurrentWindow().label.startsWith("tabwin-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDetachedTabWindow ? <DetachedTabWindow /> : <App />}
  </React.StrictMode>,
);
