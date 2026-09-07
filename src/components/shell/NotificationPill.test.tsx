/**
 * @vitest-environment jsdom
 *
 * The pill's contract is subtractive — no actions, no file, no close button —
 * so what is worth pinning is what it *does* still carry, and the two places
 * it differs from the card: the density trade (the detail is what compact
 * drops) and the fact that the whole control is the dismiss target.
 *
 * `notify.test.tsx` covers which notifications become pills at all; this file
 * assumes that decision has already been made.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real i18n on purpose: `src/lib/i18n` is initialised as a side effect of the
// import chain below, so stubbing `react-i18next` would strip
// `initReactI18next` out from under it.
const { NotificationPill } = await import("./NotificationPill");

afterEach(cleanup);

/** The pill itself — it is the button, which is also the dismiss target. */
const pill = () => screen.getByRole("button");

describe("NotificationPill", () => {
  it("shows the title", () => {
    render(
      <NotificationPill
        kind="success"
        title="Cell saved"
        density="comfortable"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Cell saved")).toBeTruthy();
  });

  it("dismisses when the pill is clicked — there is no close button", () => {
    const onDismiss = vi.fn();
    render(
      <NotificationPill
        kind="success"
        title="Cell saved"
        density="comfortable"
        align="end"
        onDismiss={onDismiss}
      />,
    );
    pill().click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("counts folded repeats, and stays silent for a single occurrence", () => {
    const { rerender } = render(
      <NotificationPill
        kind="success"
        title="Row saved"
        count={1}
        density="comfortable"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByText("×1")).toBeNull();

    rerender(
      <NotificationPill
        kind="success"
        title="Row saved"
        count={3}
        density="comfortable"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("drops the suffix in compact, the way the card drops its body line", () => {
    const props = {
      kind: "success" as const,
      title: "Cell saved",
      suffix: "Artist.Name",
      align: "end" as const,
      onDismiss: () => {},
    };
    const { rerender } = render(
      <NotificationPill {...props} density="comfortable" />,
    );
    expect(screen.getByText("Artist.Name")).toBeTruthy();

    rerender(<NotificationPill {...props} density="compact" />);
    expect(screen.queryByText("Artist.Name")).toBeNull();
  });

  it("is shorter in compact than in comfortable", () => {
    const { rerender } = render(
      <NotificationPill
        kind="success"
        title="Cell saved"
        density="comfortable"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(pill().className).toContain("h-8");

    rerender(
      <NotificationPill
        kind="success"
        title="Cell saved"
        density="compact"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(pill().className).toContain("h-7");
  });

  it("renders progress as a percentage inside the pill", () => {
    render(
      <NotificationPill
        kind="progress"
        title="Exporting Track…"
        progress={{ done: 1240, total: 3503 }}
        density="comfortable"
        align="center"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("35%")).toBeTruthy();
  });

  it("spins only while a progress bar has no numbers yet", () => {
    const { rerender } = render(
      <NotificationPill
        kind="progress"
        title="Exporting…"
        density="comfortable"
        align="center"
        onDismiss={() => {}}
      />,
    );
    expect(pill().querySelector(".animate-spin")).toBeTruthy();

    rerender(
      <NotificationPill
        kind="progress"
        title="Exporting…"
        progress={{ done: 1, total: 4 }}
        density="comfortable"
        align="center"
        onDismiss={() => {}}
      />,
    );
    expect(pill().querySelector(".animate-spin")).toBeNull();
  });

  it("hugs the edge its stack grows from", () => {
    const { container, rerender } = render(
      <NotificationPill
        kind="info"
        title="Connection restored"
        density="comfortable"
        align="end"
        onDismiss={() => {}}
      />,
    );
    expect(container.firstElementChild?.className).toContain("justify-end");

    rerender(
      <NotificationPill
        kind="info"
        title="Connection restored"
        density="comfortable"
        align="center"
        onDismiss={() => {}}
      />,
    );
    expect(container.firstElementChild?.className).toContain("justify-center");
  });
});
