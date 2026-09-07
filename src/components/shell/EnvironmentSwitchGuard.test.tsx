/**
 * @vitest-environment jsdom
 *
 * The guard's job is not decorative: it is the only thing standing between a
 * user's click and a half-torn-down session (see the component's own doc).
 * These pin the two mechanisms it needs — a curtain that actually takes the
 * pointer, and `inert` on the content so the keyboard cannot walk past it —
 * plus the fact that neither exists while nothing is switching.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// Real i18n on purpose: `src/lib/i18n` is initialised as a side effect of the
// import chain below, so stubbing `react-i18next` would strip
// `initReactI18next` out from under it.
const { useEnvironments } = await import("@/stores/session/environments");
const { EnvironmentSwitchGuard } = await import("./EnvironmentSwitchGuard");

const ENV = {
  id: "env-b",
  name: "Staging",
  color: null,
  icon: null,
  order: 0,
  themeId: null,
};

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], switchingTo: null });
});

function renderGuard() {
  return render(
    <EnvironmentSwitchGuard>
      <button type="button">row</button>
    </EnvironmentSwitchGuard>,
  );
}

describe("EnvironmentSwitchGuard", () => {
  it("stays out of the way while nothing is switching", () => {
    useEnvironments.setState({ environments: [ENV], switchingTo: null });
    renderGuard();

    expect(screen.queryByRole("status")).toBeNull();
    const content = screen.getByText("row").parentElement as HTMLElement;
    expect(content.inert).toBe(false);
  });

  it("curtains and inerts the content while a switch is in flight", () => {
    useEnvironments.setState({ environments: [ENV], switchingTo: "env-b" });
    renderGuard();

    const curtain = screen.getByRole("status");
    // A sibling of the content, never a child: inerting the curtain along with
    // it would hide the spinner from assistive tech and make it unhittable.
    const content = screen.getByText("row").parentElement as HTMLElement;
    expect(content.contains(curtain)).toBe(false);
    expect(content.inert).toBe(true);
    // Not `pointer-events-none` — the whole point is that it takes the click.
    expect(curtain.className).not.toContain("pointer-events-none");
    expect(curtain.textContent).toContain("Staging");
  });

  it("lifts both once the switch finishes", () => {
    useEnvironments.setState({ environments: [ENV], switchingTo: "env-b" });
    const { rerender } = renderGuard();

    useEnvironments.setState({ switchingTo: null });
    rerender(
      <EnvironmentSwitchGuard>
        <button type="button">row</button>
      </EnvironmentSwitchGuard>,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByText("row").parentElement as HTMLElement).inert).toBe(
      false,
    );
  });
});
