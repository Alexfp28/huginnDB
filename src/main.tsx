import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { DetachedTabWindow } from "./components/DetachedTabWindow";
import "./lib/monaco-setup";
import "./lib/i18n";
import "./index.css";

// A "sacar como ventana flotante" window (see `open_tab_window` /
// `TabbedArea`'s floatPanel action) is labeled "tabwin-<uuid>" and renders a
// single bare tab instead of the full app shell.
const isDetachedTabWindow = getCurrentWindow().label.startsWith("tabwin-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDetachedTabWindow ? <DetachedTabWindow /> : <App />}
  </React.StrictMode>,
);
