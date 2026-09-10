import { beforeEach, describe, expect, it } from "vitest";

import { useAi } from "./ai";
import { resultFor } from "@/lib/ai/parts";

/** The last assistant message's parts for a connection. */
function parts(connectionId: string) {
  const messages = useAi.getState().conversations[connectionId]?.messages ?? [];
  return messages[messages.length - 1]?.parts ?? [];
}

beforeEach(() => {
  useAi.setState({ conversations: {}, turnOwners: {}, drafts: {} });
});

describe("the AI conversation store", () => {
  it("opens a turn with the request and an empty reply", () => {
    useAi.getState().startTurn("c1", "t1", "which tables?");
    const messages = useAi.getState().conversations.c1!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].parts).toEqual([
      { type: "text", text: "which tables?" },
    ]);
    expect(messages[1].parts).toEqual([]);
    expect(useAi.getState().conversations.c1!.turnId).toBe("t1");
  });

  it("folds a tool call and then its result into the reply", () => {
    useAi.getState().startTurn("c1", "t1", "how many orders?");
    useAi.getState().pushToolCall("t1", {
      id: "call_1",
      name: "run_query",
      args: { sql: "SELECT count(*) FROM orders" },
    });

    // The card renders from the call alone — a result that has not arrived is
    // a query still running, which is exactly when someone is watching.
    expect(parts("c1")).toHaveLength(1);
    expect(resultFor(parts("c1"), "call_1")).toBeUndefined();

    useAi.getState().pushToolResult("t1", {
      id: "call_1",
      name: "run_query",
      result: { rows: [[42]] },
    });
    expect(resultFor(parts("c1"), "call_1")?.result).toEqual({ rows: [[42]] });
  });

  it("keeps a refusal as the result's error", () => {
    useAi.getState().startTurn("c1", "t1", "delete everything");
    useAi.getState().pushToolCall("t1", { id: "c", name: "run_query", args: {} });
    useAi.getState().pushToolResult("t1", {
      id: "c",
      name: "run_query",
      result: null,
      error: "this tool runs read-only statements",
    });
    expect(resultFor(parts("c1"), "c")?.error).toMatch(/read-only/);
  });

  /**
   * The subtle one. Cancelling closes the socket, but a frame already in the
   * queue still lands — and so can a tool event the loop had already emitted.
   * Folding those in would let the transcript grow after the user pressed stop.
   */
  it("drops events for a turn that is no longer running", () => {
    useAi.getState().startTurn("c1", "t1", "hi");
    useAi.getState().pushDelta("t1", "one ");
    useAi.getState().failTurn("t1", "the turn was cancelled");

    useAi.getState().pushDelta("t1", "two");
    useAi.getState().pushToolCall("t1", { id: "c", name: "list_tables", args: {} });

    expect(parts("c1")).toEqual([{ type: "text", text: "one " }]);
    expect(useAi.getState().conversations.c1!.error).toMatch(/cancelled/);
    expect(useAi.getState().conversations.c1!.turnId).toBeNull();
  });

  it("ignores an event for a turn it never knew about", () => {
    useAi.getState().pushDelta("ghost", "x");
    useAi.getState().pushToolCall("ghost", { id: "c", name: "n", args: {} });
    expect(useAi.getState().conversations).toEqual({});
  });

  /** A dropped delta leaves a gap in the middle, so the whole text is
   *  replaced rather than patched — and the tool parts survive it. */
  it("reconciles the text on completion without losing tool parts", () => {
    useAi.getState().startTurn("c1", "t1", "hi");
    useAi.getState().pushToolCall("t1", { id: "c", name: "list_tables", args: {} });
    useAi.getState().pushDelta("t1", "Thr");
    useAi.getState().finishTurn("t1", "Three tables.");

    expect(parts("c1")).toEqual([
      { type: "toolCall", id: "c", name: "list_tables", args: {} },
      { type: "text", text: "Three tables." },
    ]);
    expect(useAi.getState().conversations.c1!.turnId).toBeNull();
  });

  it("keeps each connection's turns to itself", () => {
    useAi.getState().startTurn("c1", "t1", "about c1");
    useAi.getState().startTurn("c2", "t2", "about c2");
    useAi.getState().pushDelta("t2", "answer for c2");

    expect(parts("c1")).toEqual([]);
    expect(parts("c2")).toEqual([{ type: "text", text: "answer for c2" }]);
  });

  it("forgets one connection's transcript on demand", () => {
    useAi.getState().startTurn("c1", "t1", "hi");
    useAi.getState().finishTurn("t1", "hello");
    useAi.getState().clear("c1");
    expect(useAi.getState().conversations.c1).toBeUndefined();
  });
});
