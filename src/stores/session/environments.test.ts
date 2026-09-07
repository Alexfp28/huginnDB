import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchState } from "@/types";

// Only the calls `switchTo`/`restoreSession` themselves make. Nothing here
// touches a real backend — that's the point of testing the store in
// isolation from the Tauri IPC wrapper.
const getLaunchState = vi.fn<() => Promise<LaunchState>>();
const saveLaunchState = vi.fn().mockResolvedValue(undefined);
const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
// The extra half `createAndEnter` needs: it reads the outgoing session, mints
// the environment, re-enters it and then seeds it.
const getTabState = vi.fn().mockResolvedValue(null);
const saveTabState = vi.fn().mockResolvedValue(undefined);
const getWorkspaceLayout = vi.fn().mockResolvedValue(null);
const saveWorkspaceLayout = vi.fn().mockResolvedValue(undefined);
const saveEnvironment = vi.fn();
const listEnvironments = vi.fn();
vi.mock("@/lib/tauri", () => ({
  api: {
    getLaunchState: (...args: unknown[]) => getLaunchState(...(args as [])),
    saveLaunchState: (...args: unknown[]) => saveLaunchState(...args),
    setActiveEnvironment: (...args: unknown[]) => setActiveEnvironment(...args),
    getTabState: (...args: unknown[]) => getTabState(...args),
    saveTabState: (...args: unknown[]) => saveTabState(...args),
    getWorkspaceLayout: (...args: unknown[]) => getWorkspaceLayout(...args),
    saveWorkspaceLayout: (...args: unknown[]) => saveWorkspaceLayout(...args),
    saveEnvironment: (...args: unknown[]) => saveEnvironment(...args),
    listEnvironments: (...args: unknown[]) => listEnvironments(...args),
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

describe("useEnvironments.createAndEnter — the guard flag spans the seeding pass", () => {
  const ENV_A = {
    id: "env-a",
    name: "A",
    color: null,
    icon: null,
    order: 0,
    themeId: null,
  };
  const ENV_NEW = {
    id: "env-new",
    name: "New",
    color: null,
    icon: null,
    order: 1,
    themeId: null,
  };

  beforeEach(() => {
    reconnectOnLaunch = false;
    getLaunchState.mockReset();
    getLaunchState.mockResolvedValue({
      activeConnections: [],
      selectedConnectionId: null,
      activeTabId: null,
      collapsedConnections: [],
      visibleConnections: [],
      databaseVisibility: {},
    });
    saveLaunchState.mockClear();
    setActiveEnvironment.mockClear();
    getTabState.mockClear().mockResolvedValue(null);
    saveTabState.mockClear();
    getWorkspaceLayout.mockClear().mockResolvedValue(null);
    saveWorkspaceLayout.mockReset().mockResolvedValue(undefined);
    saveEnvironment.mockReset().mockResolvedValue(ENV_NEW);
    // `create` refreshes the list from the backend, which has NOT switched the
    // active pointer yet — that is `switchTo`'s job a line later.
    listEnvironments.mockReset().mockResolvedValue({
      environments: [ENV_A, ENV_NEW],
      activeEnvironmentId: "env-a",
    });

    useEnvironments.setState({
      environments: [ENV_A],
      activeId: "env-a",
      switchingTo: null,
      error: null,
    });
    useConnections.setState({
      profiles: [],
      active: new Set(["outgoing-conn"]),
      disconnect: vi.fn().mockResolvedValue(undefined),
    });
    useUi.setState({
      selectedConnectionId: "outgoing-conn",
      collapsedConnections: [],
      visibleConnections: ["outgoing-conn"],
      databaseVisibility: {},
    });
  });

  it("keeps switchingTo raised while the new environment is being seeded", async () => {
    // Park the run inside the seeding block. `switchTo` has already finished
    // (and cleared its own flag) by the time this is reached, so anything
    // still true here is `createAndEnter`'s doing.
    let resolveLayoutSave!: () => void;
    saveWorkspaceLayout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLayoutSave = resolve;
        }),
    );

    const creating = useEnvironments
      .getState()
      .createAndEnter(
        { name: "New" },
        { connections: true, layout: true },
      );
    await flushMicrotasks(20);

    expect(useEnvironments.getState().activeId).toBe("env-new");
    expect(useEnvironments.getState().switchingTo).toBe("env-new");

    resolveLayoutSave();
    await creating;

    expect(useEnvironments.getState().switchingTo).toBeNull();
  });

  it("clears switchingTo even when the seeding pass throws", async () => {
    saveWorkspaceLayout.mockRejectedValue(new Error("boom"));

    await useEnvironments
      .getState()
      .createAndEnter({ name: "New" }, { connections: true, layout: true });

    expect(useEnvironments.getState().switchingTo).toBeNull();
    expect(useEnvironments.getState().error).toContain("boom");
  });
});
