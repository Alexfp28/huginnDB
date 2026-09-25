/**
 * @vitest-environment jsdom
 *
 * `FoldRow` replaced six hand-written headers across Settings' three
 * connection pickers, so what these pin is what those copies agreed on — and
 * the one thing they all lacked, `aria-expanded`.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Folder } from "lucide-react";
import { FoldRow } from "./fold-row";

afterEach(() => {
  cleanup();
});

const button = () => screen.getByRole("button") as HTMLButtonElement;

describe("FoldRow", () => {
  it("reports its state through aria-expanded, not only the chevron", () => {
    render(<FoldRow open label="Local" />);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    cleanup();
    render(<FoldRow open={false} label="Local" />);
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("is a plain button, so it never submits a surrounding form", () => {
    render(<FoldRow open label="Local" />);
    expect(button().type).toBe("button");
  });

  it("renders the label and a parenthesised count", () => {
    render(<FoldRow open label="Staging" count={3} />);
    expect(button().textContent).toBe("Staging(3)");
  });

  it("omits the count when none is given, but keeps a zero", () => {
    render(<FoldRow open label="Staging" />);
    expect(button().textContent).toBe("Staging");
    cleanup();
    render(<FoldRow open label="Staging" count={0} />);
    expect(button().textContent).toBe("Staging(0)");
  });

  it("draws the optional icon beside the chevron", () => {
    render(<FoldRow open label="Staging" />);
    expect(button().querySelectorAll("svg")).toHaveLength(1);
    cleanup();
    render(<FoldRow open label="Staging" icon={Folder} />);
    expect(button().querySelectorAll("svg")).toHaveLength(2);
  });

  it("sets a group in the micro heading and a section in sentence case", () => {
    render(<FoldRow open label="a" level="group" />);
    expect(button().className).toContain("uppercase");
    cleanup();
    render(<FoldRow open label="a" />);
    expect(button().className).toContain("text-2xs");
    expect(button().className).not.toContain("uppercase");
  });

  it("forwards the click and lets the consumer's className win", () => {
    const onClick = vi.fn();
    render(
      <FoldRow open label="a" className="flex-none" onClick={onClick} />,
    );
    fireEvent.click(button());
    expect(onClick).toHaveBeenCalledOnce();
    expect(button().className).toContain("flex-none");
    expect(button().className).not.toContain("flex-1");
  });
});
