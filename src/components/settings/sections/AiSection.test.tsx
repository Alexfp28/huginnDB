/**
 * @vitest-environment jsdom
 *
 * Wiring test for Settings → AI.
 *
 * It exists because phase 3's acceptance criterion is "the section renders and
 * the feature is off on a fresh profile", and a criterion checked once by hand
 * is a criterion that stops being true. What it covers is the part unit tests
 * cannot reach: that the two per-connection flags write through the *dedicated*
 * commands rather than `saveProfile`, that the rows column tells the truth about
 * the coupling rule when the endpoint is trusted, and that the probe's verdict
 * reaches the screen verbatim.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { AiSection } from "./AiSection";
import { usePreferences } from "@/stores/preferences/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type { AiProbeReport, ConnectionProfile } from "@/types";

const listProfiles = vi.fn<() => Promise<ConnectionProfile[]>>();
const aiHasKey = vi.fn<() => Promise<boolean>>();
const aiProbe = vi.fn<(refresh?: boolean) => Promise<AiProbeReport>>();
const setAiEnabled = vi.fn<(ids: string[], on: boolean) => Promise<number>>();
const setAiRowsAllowed =
  vi.fn<(ids: string[], on: boolean) => Promise<number>>();
const setAiNotes = vi.fn<(id: string, notes: string) => Promise<number>>();

vi.mock("@/lib/tauri", () => ({
  api: {
    listProfiles: () => listProfiles(),
    aiHasKey: () => aiHasKey(),
    aiProbe: (refresh?: boolean) => aiProbe(refresh),
    setAiEnabled: (ids: string[], on: boolean) => setAiEnabled(ids, on),
    setAiRowsAllowed: (ids: string[], on: boolean) =>
      setAiRowsAllowed(ids, on),
    setAiNotes: (id: string, notes: string) => setAiNotes(id, notes),
    aiSetKey: () => Promise.resolve(),
    aiClearKey: () => Promise.resolve(),
    // The preferences store schedules a debounced save on every setter.
    updatePreferences: () => Promise.resolve(),
  },
}));

function profile(over: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "p1",
    name: "Bonfire",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    database: "shop",
    username: "reader",
    ssl: false,
    ...over,
  };
}

/**
 * Wait until the mount effects have *rendered*, not merely fired.
 *
 * Awaiting the mock calls is the obvious version and the wrong one: both
 * resolve on mount, so a query right after still runs against the render that
 * predates the profile list.
 */
async function settle() {
  await vi.waitFor(() => expect(screen.getByText(/reachable$/i)).toBeTruthy());
}

/** One of the section's text/number fields, by the id its `PrefRow` labels. */
function field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function rowsCheckbox(): HTMLInputElement {
  return screen.getByRole("checkbox", {
    name: /allow rows from bonfire/i,
  }) as HTMLInputElement;
}

beforeEach(() => {
  listProfiles.mockReset().mockResolvedValue([profile()]);
  aiHasKey.mockReset().mockResolvedValue(false);
  aiProbe.mockReset();
  setAiEnabled.mockReset().mockResolvedValue(1);
  setAiRowsAllowed.mockReset().mockResolvedValue(1);
  setAiNotes.mockReset().mockResolvedValue(1);
  // A fresh install: the store starts on `DEFAULT_PREFS`, which is the state
  // this test is partly about.
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ai: { ...s.prefs.ai } },
  }));
});

afterEach(() => {
  // Explicit because this project's vitest config sets no `globals`, so
  // testing-library never registers its automatic cleanup.
  cleanup();
});

describe("Settings → AI", () => {
  /** The phase's acceptance criterion, and the one that must never drift. */
  it("renders with the panel switched off on a fresh profile", async () => {
    render(<AiSection />);
    await settle();

    // Plain DOM assertions throughout: this project does not register
    // `@testing-library/jest-dom`, so `toBeChecked` and friends are not
    // available and fail as an unknown Chai property rather than as a
    // meaningful mismatch.
    const master = screen.getByRole("switch", {
      name: /enable the ai panel/i,
    });
    expect(master.getAttribute("aria-checked")).toBe("false");
    // Ollama's default is pre-filled; the model is not, because it depends on
    // what the endpoint serves.
    expect(field("prefs-ai-base-url").value).toBe("http://localhost:11434/v1");
    expect(field("prefs-ai-model").value).toBe("");
    // Untrusted, so the coupling rule starts at metadata-only.
    expect(
      screen.getByRole("radio", { name: /third party/i }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    // And nothing is reachable yet.
    expect(screen.getByText("0 of 1 reachable")).toBeTruthy();
  });

  it("writes reach through the dedicated command, not the whole profile", async () => {
    render(<AiSection />);
    await settle();

    fireEvent.click(
      screen.getByRole("switch", { name: /let the assistant reach bonfire/i }),
    );
    expect(setAiEnabled).toHaveBeenCalledWith(["p1"], true);
    expect(setAiRowsAllowed).not.toHaveBeenCalled();
  });

  it("writes row access through its own command once a connection is reachable", async () => {
    listProfiles.mockResolvedValue([profile({ ai_enabled: true })]);
    render(<AiSection />);
    await settle();

    const rows = rowsCheckbox();
    expect(rows.disabled).toBe(false);
    fireEvent.click(rows);
    expect(setAiRowsAllowed).toHaveBeenCalledWith(["p1"], true);
  });

  /**
   * The honesty requirement. A trusted endpoint reads rows whatever this flag
   * says (`DataScope::resolve`), so a checkbox that looked like it withheld
   * them would be a lie about the one thing this panel exists to be clear
   * about.
   */
  it("shows row access as locked-on while the endpoint is trusted", async () => {
    listProfiles.mockResolvedValue([profile({ ai_enabled: true })]);
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ai: { ...s.prefs.ai, endpointTrust: "trusted" } },
    }));
    render(<AiSection />);
    await settle();

    const rows = rowsCheckbox();
    expect(rows.disabled).toBe(true);
    expect(rows.checked).toBe(true);

    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ai: { ...s.prefs.ai, endpointTrust: "untrusted" } },
    }));
  });

  /**
   * Verbatim, because a paraphrase drops the detail that identifies the
   * misconfiguration — and the warning has to appear when the *chosen* mode is
   * one the measured endpoint cannot deliver.
   */
  it("shows the probe verdict verbatim and warns when agent mode is unavailable", async () => {
    aiProbe.mockResolvedValue({
      key: "http://localhost:11434/v1|llama3.1:8b",
      capability: { kind: "chatOnly" },
      models: [],
      note: "This model answered in prose instead of calling the test function.",
    });
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled: true, mode: "agent" } },
    }));
    render(<AiSection />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /test endpoint/i }));
    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "This model answered in prose instead of calling the test function.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/chat only/i)).toBeTruthy();
    expect(
      screen.getByText(/agent mode will not work with it/i),
    ).toBeTruthy();

    usePreferences.setState((s) => ({
      prefs: {
        ...s.prefs,
        ai: { ...s.prefs.ai, enabled: false, mode: "assisted" },
      },
    }));
  });

  /**
   * The honest answer to "I already pay for Claude" (`docs/AI_ROADMAP.md` §1).
   * An empty state that pretended this panel were the only option would cost a
   * user the licence they already have.
   */
  /**
   * The context a schema cannot carry. A model can read every table and still
   * not know which of two similar ones is live — so the user gets to say it
   * once, per connection, instead of retyping it every conversation.
   */
  it("saves per-connection context notes on blur, through their own command", async () => {
    listProfiles
      .mockReset()
      .mockResolvedValue([
        profile({ ai_enabled: true, ai_notes: "cfg_* is one row per tenant" }),
      ]);
    render(<AiSection />);
    await settle();

    const notes = screen.getByPlaceholderText(/cfg_\*/i) as HTMLTextAreaElement;
    // Loaded from the profile, not empty: the note is a thing you edit.
    expect(notes.value).toBe("cfg_* is one row per tenant");
    // Bounded, so the textarea cannot accept what the backend would drop.
    expect(notes.getAttribute("maxlength")).toBe("2000");

    fireEvent.change(notes, { target: { value: "  status uses legacy codes  " } });
    // Nothing written yet: prose is saved on blur, not per keystroke.
    expect(setAiNotes).not.toHaveBeenCalled();
    fireEvent.blur(notes);
    await vi.waitFor(() =>
      expect(setAiNotes).toHaveBeenCalledWith("p1", "status uses legacy codes"),
    );

    // Unchanged text does not write again.
    setAiNotes.mockClear();
    fireEvent.blur(notes);
    expect(setAiNotes).not.toHaveBeenCalled();
  });

  /** A connection the assistant cannot reach has nothing to be told. */
  it("offers no notes editor until a connection is reachable", async () => {
    render(<AiSection />);
    await settle();
    expect(screen.queryByPlaceholderText(/cfg_\*/i)).toBeNull();
    expect(screen.getByText(/enable a connection above/i)).toBeTruthy();
  });

  it("offers the MCP connector as the route for an existing subscription", async () => {
    render(<AiSection />);
    await settle();

    expect(screen.getByText(/cannot be spent through huginndb/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open mcp settings/i }));
    expect(useSettingsDialog.getState().section).toBe("mcp");
  });
});
