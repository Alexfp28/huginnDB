/**
 * @vitest-environment jsdom
 *
 * Wiring test for the AI panel.
 *
 * Phase 4's acceptance criterion is that the panel opens, streams, renders
 * tool-call cards and offers a proposed statement to the editor. Three of those
 * are checked here; the fourth (the block's lens) is
 * `parts/SqlBlock.test.tsx`, since Monaco cannot mount in jsdom.
 *
 * What it is really guarding is the shape of what goes *out*: that a turn
 * carries the system prompt which tells the model it cannot read the database,
 * that the user's message is not sent twice, and that each connection's
 * conversation stays its own. The first of those is a correctness property, not
 * a formatting one — without it a model with no tools invents a schema and
 * presents it as read.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { AiPanel } from "./AiPanel";
import { useAi } from "@/stores/session/ai";
import { useConnections } from "@/stores/session/connections";
import { usePreferences } from "@/stores/preferences/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type { AiChatMessage, AiTurnResult } from "@/types";

const aiSend = vi.fn<
  (turnId: string, messages: AiChatMessage[]) => Promise<AiTurnResult>
>();
const aiCancel = vi.fn<(turnId: string) => Promise<boolean>>();
const aiModels = vi.fn<() => Promise<string[]>>();
const aiTask = vi.fn<
  (turnId: string, input: unknown) => Promise<AiTurnResult>
>();

vi.mock("@/lib/tauri", () => ({
  api: {
    aiSend: (turnId: string, messages: AiChatMessage[]) =>
      aiSend(turnId, messages),
    aiCancel: (turnId: string) => aiCancel(turnId),
    aiModels: () => aiModels(),
    aiTask: (turnId: string, input: unknown) => aiTask(turnId, input),
    // The preferences store schedules a debounced save on every setter.
    updatePreferences: () => Promise.resolve(),
  },
}));

// Monaco needs a real layout and a worker; the SQL block's own contract is
// covered in `parts/SqlBlock.test.tsx`.
vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => (
    <pre data-testid="sql-block">{value}</pre>
  ),
}));

function enablePanel(enabled: boolean) {
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled, model: "llama3.1:8b" } },
  }));
}

beforeEach(() => {
  aiSend.mockReset();
  aiCancel.mockReset().mockResolvedValue(true);
  aiModels.mockReset().mockResolvedValue(["llama3.1:8b", "gemma4:12b"]);
  aiTask.mockReset().mockResolvedValue({ content: "ok", finishReason: "stop" });
  useConnections.setState({ profiles: [] });
  useAi.setState({ conversations: {}, turnOwners: {}, drafts: {} });
  enablePanel(true);
});

afterEach(() => {
  // Explicit because this project's vitest config sets no `globals`, so
  // testing-library never registers its automatic cleanup.
  cleanup();
  enablePanel(false);
});

describe("AiPanel", () => {
  it("points at Settings while the feature is off", () => {
    enablePanel(false);
    render(<AiPanel connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /open ai settings/i }));
    expect(useSettingsDialog.getState().section).toBe("ai");
  });

  it("asks for a connection when none is selected", () => {
    render(<AiPanel connectionId={null} />);
    expect(screen.getByText(/no connection selected/i)).toBeTruthy();
  });

  /**
   * The system prompt is the correctness property here: with no tools, a model
   * asked "which tables are there?" will invent an answer unless it is told it
   * cannot look — and a confident fabricated schema is worse than a refusal.
   */
  it("sends the system prompt and the user's message exactly once", async () => {
    aiSend.mockResolvedValue({ content: "Three tables.", finishReason: "stop" });
    render(<AiPanel connectionId="c1" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "which tables?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await vi.waitFor(() => expect(aiSend).toHaveBeenCalled());
    const [, messages] = aiSend.mock.calls[0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toMatch(/NO access to the user's database/);
    expect(messages.filter((m) => m.role === "user")).toEqual([
      { role: "user", content: "which tables?" },
    ]);
  });

  it("renders streamed deltas as they arrive and reconciles on completion", async () => {
    let resolveTurn: (r: AiTurnResult) => void = () => {};
    aiSend.mockImplementation(
      () => new Promise<AiTurnResult>((r) => (resolveTurn = r)),
    );
    render(<AiPanel connectionId="c1" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hola" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await vi.waitFor(() => expect(aiSend).toHaveBeenCalled());

    // What the bridge does when a delta event lands.
    const turnId = aiSend.mock.calls[0][0];
    useAi.getState().pushDelta(turnId, "Tres ");
    useAi.getState().pushDelta(turnId, "tablas.");
    await vi.waitFor(() => expect(screen.getByText("Tres tablas.")).toBeTruthy());

    // While a turn is open the composer offers Stop, not Send.
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(aiCancel).toHaveBeenCalledWith(turnId);

    resolveTurn({ content: "Tres tablas.", finishReason: "stop" });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy(),
    );
  });

  it("shows a failed turn's reason instead of leaving it spinning", async () => {
    aiSend.mockRejectedValue("inference error: connection refused");
    render(<AiPanel connectionId="c1" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await vi.waitFor(() =>
      expect(screen.getByText(/connection refused/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
  });

  /**
   * The trust feature in miniature: the card names the tool and reports a row
   * *count*, which is the number that tells someone whether data left the
   * machine. Nothing produces these until phase 6's loop, so the renderer is
   * driven from the store here.
   */
  it("renders a tool call as a card with its name and row count", () => {
    useAi.setState({
      conversations: {
        c1: {
          turnId: null,
          error: null,
          messages: [
            {
              id: "m1",
              role: "assistant",
              parts: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "browse_table",
                  args: { table: "orders" },
                },
                {
                  type: "toolResult",
                  id: "call_1",
                  name: "browse_table",
                  result: { rows: [[1], [2], [3]], truncated: true },
                },
              ],
            },
          ],
        },
      },
    });
    render(<AiPanel connectionId="c1" />);
    expect(screen.getByText("browse_table")).toBeTruthy();
    expect(screen.getByText(/3 rows/)).toBeTruthy();
    // The cap is reported, so "3 rows" cannot be mistaken for the whole table.
    expect(screen.getByText(/capped/)).toBeTruthy();
  });

  /** The conversation is keyed by connection, so switching shows that
   *  connection's own thread rather than re-pointing this one. */
  it("keeps each connection's conversation separate", () => {
    useAi.setState({
      conversations: {
        c1: {
          turnId: null,
          error: null,
          messages: [
            { id: "a", role: "user", parts: [{ type: "text", text: "about c1" }] },
          ],
        },
        c2: {
          turnId: null,
          error: null,
          messages: [
            { id: "b", role: "user", parts: [{ type: "text", text: "about c2" }] },
          ],
        },
      },
    });
    const { unmount } = render(<AiPanel connectionId="c1" />);
    expect(screen.getByText("about c1")).toBeTruthy();
    expect(screen.queryByText("about c2")).toBeNull();
    unmount();

    render(<AiPanel connectionId="c2" />);
    expect(screen.getByText("about c2")).toBeTruthy();
  });

  /**
   * The affordance that actually reads the database, and the answer to "it
   * cannot see my schema": plain chat has no tools until the agent loop lands,
   * so a schema question is answered from the schema only when the user asks
   * for it this way — `nlToSql`, whose context Rust assembles.
   */
  it("sends the draft as an nlToSql task rather than as a chat turn", async () => {
    useConnections.setState({
      profiles: [
        {
          id: "c1",
          name: "Bonfire",
          driver: "postgres",
          host: "localhost",
          port: 5432,
          database: "shop",
          username: "u",
          ssl: false,
          ai_enabled: true,
        },
      ],
    });
    render(<AiPanel connectionId="c1" />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ventas del último mes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /write sql/i }));

    await vi.waitFor(() => expect(aiTask).toHaveBeenCalled());
    expect(aiTask.mock.calls[0][1]).toEqual({
      task: "nlToSql",
      connection: "c1",
      question: "ventas del último mes",
    });
    // Not the chat path — that one has no schema to answer from.
    expect(aiSend).not.toHaveBeenCalled();
  });

  /** Without reach the task would only fail, so the affordance is absent
   *  rather than present-and-broken. */
  it("hides the SQL action for a connection the assistant cannot read", () => {
    render(<AiPanel connectionId="c1" />);
    expect(screen.queryByRole("button", { name: /write sql/i })).toBeNull();
  });

  /** A fenced statement becomes a block rather than prose. */
  it("renders a proposed statement as a SQL block", () => {
    useAi.setState({
      conversations: {
        c1: {
          turnId: null,
          error: null,
          messages: [
            {
              id: "m1",
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: "Try:\n```sql\nSELECT * FROM orders LIMIT 10;\n```",
                },
              ],
            },
          ],
        },
      },
    });
    render(<AiPanel connectionId="c1" />);
    expect(screen.getByText("Try:")).toBeTruthy();
    expect(screen.getByTestId("sql-block").textContent).toBe(
      "SELECT * FROM orders LIMIT 10;",
    );
  });
});
