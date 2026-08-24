/**
 * @vitest-environment jsdom
 *
 * Wiring test for the documentation viewer. `docOutline` covers the parsing;
 * what this covers is the part unit tests cannot reach — that a doc opens on its
 * cover, that picking a section shows *only* that section, and that the anchors
 * and cross-doc links written inside the real shipped docs now navigate instead
 * of doing nothing.
 *
 * It runs against the real corpus and the real registry, deliberately: a fixture
 * would pass while the shipped `docs/MCP.md` still buried its Tools section.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { DocsDialog } from "./DocsDialog";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";

// The only Tauri surface this dialog touches: opening an external URL.
const openUrl = vi.fn<(url: string) => Promise<void>>();
let scrollIntoView = vi.fn();
vi.mock("@/lib/tauri", () => ({ api: { openUrl: (u: string) => openUrl(u) } }));

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined);
  useDocsDialog.setState({
    open: true,
    activeId: "mcp",
    sectionSlug: null,
    pendingAnchor: null,
  });
  // jsdom implements neither Radix's nor our scroll effect's use of it.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  // Explicit because this project's vitest config sets no `globals`, so
  // testing-library never registers its automatic cleanup. Without it the DOM
  // accumulates and a query quietly matches the previous test's render.
  cleanup();
  useDocsDialog.setState({ open: false, activeId: null, sectionSlug: null });
});

/** The scrollable page, i.e. everything that is not the sidebar. */
function page(): HTMLElement {
  const nav = document.querySelector("nav")!;
  const pane = nav.parentElement!.querySelector<HTMLElement>(
    ":scope > div:not(nav)",
  );
  return pane!;
}

describe("DocsDialog", () => {
  it("opens a doc on its cover, not on a wall of markdown", async () => {
    render(<DocsDialog />);
    // The cover is the prose before the first `##` plus a card per section.
    expect(
      await screen.findByRole("heading", { name: /MCP connector/i, level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText("In this guide")).toBeTruthy();
    // Cards for the sections, and *not* their content.
    expect(screen.getAllByRole("button", { name: /^Security/ }).length).toBeGreaterThan(0);
    expect(page().textContent).not.toContain("read-only` (default) — only reads");
  });

  it("shows one section at a time", async () => {
    render(<DocsDialog />);

    const nav = document.querySelector("nav")!;
    fireEvent.click(within(nav).getByRole("button", { name: "Tools" }));

    const text = page().textContent ?? "";
    // The reason this feature exists: the tools table, without scrolling past
    // five client configurations to reach it.
    expect(text).toContain("save_view");
    expect(text).toContain("drop_view");
    // And nothing from a different section.
    expect(text).not.toContain("Getting the binary");
  });

  it("follows an in-document anchor from the cover", async () => {
    render(<DocsDialog />);

    // MCP.md's intro links to `[Security](#security)`.
    fireEvent.click(screen.getByRole("link", { name: "Security" }));

    await waitFor(() =>
      expect(useDocsDialog.getState().sectionSlug).toBe("security"),
    );
    expect(page().textContent).toContain("Writes gated per connection");
  });

  it("follows an anchor that points at a ### and scrolls to it", async () => {
    useDocsDialog.setState({ sectionSlug: "security" });
    render(<DocsDialog />);

    fireEvent.click(
      screen.getByRole("link", { name: /When the client blocks the call/i }),
    );

    // The scroll is deferred by a `requestAnimationFrame` — the guard that
    // exists so it lands on a laid-out element — so wait on the spy, not just
    // on the store.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const s = useDocsDialog.getState();
    // Same page: the `###` lives inside Security. The anchor is consumed.
    expect(s.sectionSlug).toBe("security");
    expect(s.pendingAnchor).toBeNull();
  });

  it("follows a relative link to another bundled doc", async () => {
    useDocsDialog.setState({ activeId: "mongodb", sectionSlug: "over-mcp" });
    render(<DocsDialog />);

    // MONGODB.md's "Over MCP" section links to [`MCP.md`](MCP.md).
    fireEvent.click(screen.getByRole("link", { name: "MCP.md" }));

    await waitFor(() => expect(useDocsDialog.getState().activeId).toBe("mcp"));
    // Landing on the new doc's cover, not on whatever section index was set.
    expect(useDocsDialog.getState().sectionSlug).toBeNull();
  });

  it("follows a cross-doc link from a cover", async () => {
    useDocsDialog.setState({ activeId: "connections", sectionSlug: null });
    render(<DocsDialog />);

    // CONNECTIONS.md's intro links to [`ENVIRONMENTS.md`](ENVIRONMENTS.md).
    fireEvent.click(screen.getByRole("link", { name: "ENVIRONMENTS.md" }));

    await waitFor(() =>
      expect(useDocsDialog.getState().activeId).toBe("environments"),
    );
  });

  it("sends a doc that is not bundled to GitHub", async () => {
    useDocsDialog.setState({ sectionSlug: "supported-drivers" });
    render(<DocsDialog />);

    fireEvent.click(
      screen.getByRole("link", { name: "MCP_CONNECTOR_ROADMAP.md" }),
    );

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://github.com/Alexfp28/huginnDB/blob/main/docs/MCP_CONNECTOR_ROADMAP.md",
      ),
    );
  });

  it("resets to the cover when the doc changes", async () => {
    useDocsDialog.setState({ sectionSlug: "security" });
    render(<DocsDialog />);

    const nav = document.querySelector("nav")!;
    fireEvent.click(within(nav).getByRole("button", { name: /SQL Server/ }));

    // A section slug from the previous doc means nothing in the new one, and
    // keeping it would highlight a sidebar row that does not exist.
    expect(useDocsDialog.getState().sectionSlug).toBeNull();
  });
});
