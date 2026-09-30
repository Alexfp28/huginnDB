import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@/types";

/**
 * `enterInThisWindow` — what "Open environment in new window" hands a fresh
 * secondary window. The sibling `environments.test.ts` mocks the main window
 * for the whole file, so the secondary-window behaviour lives here.
 */

vi.mock("@/lib/tauri", () => ({ api: {} }));
vi.mock("@/lib/window", () => ({ isMainWindow: () => false }));
vi.mock("@/lib/notify", () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/lib/connection/connectFlow", () => ({
  disconnectAndClean: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/stores/session/persistedTabs", () => ({
  flushAllTabState: vi.fn(),
  suspendSaves: vi.fn(),
  resumeSaves: vi.fn(),
  hydrateWorkspaceLayout: vi.fn(),
  flushTabState: vi.fn(),
  hydrateTabState: vi.fn(),
  persistLaunchState: vi.fn(),
  subscribedConnectionIds: vi.fn(() => new Set<string>()),
}));
vi.mock("@/stores/preferences/preferences", () => ({
  usePreferences: { getState: () => ({ prefs: { ui: {} } }) },
}));
vi.mock("@/stores/preferences/theme", () => ({
  useThemeStore: { getState: () => ({ setEnvironmentOverride: vi.fn() }) },
}));

const { useEnvironments } = await import("./environments");
const { useConnections } = await import("@/stores/session/connections");
const { useUi } = await import("@/stores/session/ui");

function env(id: string, activeConnections: string[], hidden: string[] = []) {
  return {
    id,
    name: id,
    color: null,
    icon: null,
    order: 0,
    themeId: null,
    launch: {
      activeConnections,
      selectedConnectionId: null,
      activeTabId: null,
      collapsedConnections: [],
      visibleConnections: activeConnections,
      databaseVisibility: {},
      hiddenDatabases: hidden,
    },
  } as unknown as Environment;
}

const connect = vi.fn<(id: string) => Promise<void>>();
const refresh = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  connect.mockReset().mockResolvedValue(undefined);
  refresh.mockClear();
  useEnvironments.setState({
    environments: [env("main-env", ["m1"]), env("other", ["a", "b", "gone"])],
    activeId: "main-env",
    switchingTo: null,
    error: null,
  });
  useConnections.setState({
    profiles: [{ id: "a" }, { id: "b" }, { id: "m1" }] as never,
    active: new Set<string>(),
    connect: connect as never,
    refresh: refresh as never,
  });
  useUi.setState({ visibleConnections: ["m1"], collapsedConnections: [] });
});

describe("useEnvironments.enterInThisWindow", () => {
  it("points this window at the environment and opens what it had open", async () => {
    await useEnvironments.getState().enterInThisWindow("other");

    expect(useEnvironments.getState().activeId).toBe("other");
    expect(useUi.getState().visibleConnections).toEqual(["a", "b", "gone"]);
    // `gone` has no profile any more, so it is skipped rather than failing.
    expect(connect.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
  });

  it("does not reconnect what this window already has open", async () => {
    useConnections.setState({ active: new Set(["a"]) });
    await useEnvironments.getState().enterInThisWindow("other");
    expect(connect.mock.calls.map((c) => c[0])).toEqual(["b"]);
  });

  it("still connects the rest when one connection fails", async () => {
    connect.mockImplementation(async (id) => {
      if (id === "a") throw new Error("refused");
    });
    await useEnvironments.getState().enterInThisWindow("other");
    expect(connect.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
  });

  it("leaves the window alone for an environment that no longer exists", async () => {
    await useEnvironments.getState().enterInThisWindow("deleted-meanwhile");
    expect(useEnvironments.getState().activeId).toBe("main-env");
    expect(useUi.getState().visibleConnections).toEqual(["m1"]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects the environment's connections when it is already the active one", async () => {
    await useEnvironments.getState().enterInThisWindow("main-env");
    expect(connect.mock.calls.map((c) => c[0])).toEqual(["m1"]);
  });
});
