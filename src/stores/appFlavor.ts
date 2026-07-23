/**
 * App-flavor store — tells the UI whether it is running inside the stable
 * build or the isolated **canary** sandbox build.
 *
 * The React bundle is byte-for-byte identical across flavors (only the Cargo
 * `canary` feature + Tauri config overlay differ), so the frontend cannot know
 * its flavor at build time — it must ask the backend. `load()` calls the
 * `get_app_flavor` command once at launch; the result is static for the life
 * of the process, so there is no refresh path.
 *
 * Drives the sandbox indicator: `SandboxRibbon` (persistent top banner), the
 * canary-aware window title (`WindowTitleSync`), and the "CANARY" badge in the
 * header breadcrumb.
 *
 * Selector note (gotcha #1): components read raw primitives (`canary`,
 * `productName`), never a derived object — keeps `Object.is` stable.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";

interface AppFlavorState {
  /** True once `load()` has resolved. Guards the indicator against flashing
   *  before the flavor is known (defaults to non-canary until then). */
  loaded: boolean;
  /** True when this is the `--features canary` sandbox build. */
  canary: boolean;
  /** Product name for this flavor: "HuginnDB Canary" or "HuginnDB". */
  productName: string;
  /** Isolated on-disk state dir ("HuginnDB-Canary" or "HuginnDB"). */
  stateDir: string;

  /** Fetch the flavor from the backend once. Idempotent; safe under a
   *  StrictMode double-effect. Failures are swallowed — an unresolved flavor
   *  simply renders as the stable build (no sandbox indicator). */
  load: () => Promise<void>;
}

export const useAppFlavor = create<AppFlavorState>()((set, get) => ({
  loaded: false,
  canary: false,
  productName: "HuginnDB",
  stateDir: "HuginnDB",

  load: async () => {
    if (get().loaded) return;
    try {
      const flavor = await api.getAppFlavor();
      set({
        loaded: true,
        canary: flavor.canary,
        productName: flavor.productName,
        stateDir: flavor.stateDir,
      });
    } catch {
      // Outside the Tauri shell / IPC failure: stay on the stable defaults.
      set({ loaded: true });
    }
  },
}));
