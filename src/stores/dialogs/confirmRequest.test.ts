import { afterEach, describe, expect, it } from "vitest";
import { useConfirmRequest } from "./confirmRequest";

afterEach(() => {
  useConfirmRequest.setState({ current: null, queue: [] });
});

describe("useConfirmRequest", () => {
  it("resolves true when the request is confirmed", async () => {
    const pending = useConfirmRequest
      .getState()
      .request({ tone: "destructive", message: "drop it?" });
    useConfirmRequest.getState().resolve(true);
    expect(await pending).toBe(true);
  });

  it("resolves false when the request is dismissed", async () => {
    const pending = useConfirmRequest
      .getState()
      .request({ tone: "irreversible", message: "sure?" });
    useConfirmRequest.getState().resolve(false);
    expect(await pending).toBe(false);
  });

  it("does not drop the first resolver when a second request arrives while one is pending", async () => {
    const first = useConfirmRequest
      .getState()
      .request({ tone: "destructive", message: "first" });
    const second = useConfirmRequest
      .getState()
      .request({ tone: "destructive", message: "second" });

    // The second request queues rather than replacing `current` — the
    // dialog still shows only the first one.
    expect(useConfirmRequest.getState().current?.message).toBe("first");
    expect(useConfirmRequest.getState().queue).toHaveLength(1);

    useConfirmRequest.getState().resolve(true);
    expect(await first).toBe(true);

    // Answering the first promotes the second into `current` — its own
    // resolver is still live, not lost.
    expect(useConfirmRequest.getState().current?.message).toBe("second");
    useConfirmRequest.getState().resolve(false);
    expect(await second).toBe(false);

    expect(useConfirmRequest.getState().current).toBeNull();
    expect(useConfirmRequest.getState().queue).toHaveLength(0);
  });
});
