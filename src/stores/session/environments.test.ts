import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchState } from "@/types";

// Only the calls `switchTo`/`restoreSession` themselves make. Nothing here
// touches a real backend — that's the point of testing the store in
// isolation from the Tauri IPC wrapper.
const getLaunchState = vi.fn<() => Promise<LaunchState>>();
const saveLaunchState = vi.fn().mockResolvedValue(undefined);
const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri", () => ({
  api: {
    getLaunchState: (...args: unknown[]) => getLaunchState(...(args as [])),
    saveLaunchState: (...args: unknown[]) => saveLaunchState(...args),
    setActiveEnvironment: (...args: unknown[]) => setActiveEnvironment(...args),
  },
}));

vi.mock("@/lib/window", () => ({ isMainWindow: () => true }));

// The tab/layout persistence machinery isn't under test here — `switchTo`
// only needs these to resolve so it can reach the disconnect loop and, after
// it, `restoreSession`.
vi.mock("@/stores/session/persistedTabs", () => ({
  flushAllTabState: vi.fn().mockResolvedValue(undefined),
  suspendSaves: vi.fn(),
  resumeSaves: vi.fn(),
  hydrateWorkspaceLayout: vi.fn().mockResolvedValue(undefined),
  flushTabState: vi.fn().mockResolvedValue(undefined),
  hydrateTabState: vi.fn().mockResolvedValue(undefined),
  persistLaunchState: vi.fn().mockResolvedValue(undefined),
  subscribedConnectionIds: vi.fn(() => new Set<string>()),
}));

let reconnectOnLaunch = false;
vi.mock("@/stores/preferences/preferences", () => ({
  usePreferences: {
    getState: () => ({ prefs: { ui: { reconnectOnLaunch } } }),
  },
}));

vi.mock("@/stores/preferences/theme", () => ({
  useThemeStore: { getState: () => ({ setEnvironmentOverride: vi.fn() }) },
}));

const { useEnvironments } = await import("./environments");
const { useConnections } = await import("@/stores/session/connections");
const { useUi } = await import("@/stores/session/ui");

/** Let queued microtasks (mocked `await`s) run without pinning an exact count. */
async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("useEnvironments.switchTo — outgoing view filter", () => {
  beforeEach(() => {
    reconnectOnLaunch = false;
    getLaunchState.mockReset();
    saveLaunchState.mockClear();
    setActiveEnvironment.mockClear();

    useEnvironments.setState({
      environments: [
        {
          id: "env-a",
          name: "A",
          color: null,
          icon: null,
          order: 0,
          themeId: null,
        },
        {
          id: "env-b",
          name: "B",
          color: null,
          icon: null,
          order: 1,
          themeId: null,
        },
      ],
      activeId: "env-a",
      switchingTo: null,
      error: null,
    });
    useConnections.setState({
      profiles: [],
      active: new Set(["outgoing-conn"]),
    });
    useUi.setState({
      selectedConnectionId: "outgoing-conn",
      collapsedConnections: [],
      visibleConnections: ["outgoing-conn"],
      databaseVisibility: {},
    });
  });

  it("keeps the outgoing environment's filter applied while its pools are still closing", async () => {
    let resolveDisconnect!: () => void;
    const disconnecting = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    useConnections.setState({ disconnect: vi.fn(() => disconnecting) });
    getLaunchState.mockResolvedValue({
      activeConnections: ["incoming-conn"],
      selectedConnectionId: null,
      activeTabId: null,
      collapsedConnections: [],
      visibleConnections: ["incoming-conn"],
      databaseVisibility: {},
    });

    const switching = useEnvironments.getState().switchTo("env-b");
    await flushMicrotasks();

    // The teardown is still stuck on the slow disconnect — the outgoing
    // environment's own filter must still be what's applied, never "show
    // everything" (`null`), which is what a full flush of every saved
    // profile from every environment looks like in `ConnectionsTree`.
    expect(useUi.getState().visibleConnections).toEqual(["outgoing-conn"]);

    resolveDisconnect();
    await switching;

    expect(useUi.getState().visibleConnections).toEqual(["incoming-conn"]);
  });

  it("clears the filter if restoreSession can't read the incoming environment's launch state", async () => {
    useConnections.setState({
      disconnect: vi.fn().mockResolvedValue(undefined),
    });
    getLaunchState.mockRejectedValue(new Error("boom"));

    await useEnvironments.getState().switchTo("env-b");

    // The one path where nothing ever supplies a real filter to replace the
    // outgoing one with — it must not stay pinned to an environment that
    // isn't active anymore.
    expect(useUi.getState().visibleConnections).toBeNull();
  });
});
