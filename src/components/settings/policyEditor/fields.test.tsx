/**
 * @vitest-environment jsdom
 *
 * The rule fields. What matters: switching a rule to "a saved connection" or
 * "by hand" never hands the draft an endpoint the parser rejects (it used to
 * write `{ host: "" }` and flash "the policy is not valid"), a picked
 * connection writes its whole server, and a name list is filled from the
 * catalog with a typed pattern checked against it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/lib/i18n";

import { EndpointField, NamePicker, matchesOf, profileFor } from "./fields";
import type { ConnectionProfile } from "@/types";

const erp = {
  id: "c1",
  name: "ERP",
  driver: "mysql",
  host: "erp.local",
  port: 3306,
  database: "",
} as unknown as ConnectionProfile;

afterEach(cleanup);

function endpoint(value: Parameters<typeof EndpointField>[0]["value"]) {
  const onChange = vi.fn();
  render(
    <EndpointField
      value={value}
      profiles={[erp]}
      readOnly={false}
      active={false}
      connecting={false}
      onConnect={() => {}}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("EndpointField", () => {
  it("does not write an empty server when the mode changes", () => {
    const onChange = endpoint("*");
    fireEvent.click(screen.getByRole("radio", { name: "A saved connection" }));
    fireEvent.click(screen.getByRole("radio", { name: "By hand" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/still applies to every server/)).toBeTruthy();
  });

  it("writes the whole server of a picked connection", () => {
    const onChange = endpoint("*");
    fireEvent.click(screen.getByRole("radio", { name: "A saved connection" }));
    fireEvent.change(screen.getByLabelText("A saved connection"), { target: { value: "c1" } });
    expect(onChange).toHaveBeenCalledWith({ driver: "mysql", host: "erp.local", port: 3306 });
  });

  it("commits a typed server only once it names a host", () => {
    const onChange = endpoint("*");
    fireEvent.click(screen.getByRole("radio", { name: "By hand" }));
    const host = screen.getByLabelText("Host");
    fireEvent.change(host, { target: { value: "   " } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(host, { target: { value: "db.local" } });
    expect(onChange).toHaveBeenLastCalledWith({ host: "db.local" });
  });

  it("recognises a rule's server as a saved connection", () => {
    expect(profileFor({ host: "ERP.local", driver: "mysql" }, [erp])?.id).toBe("c1");
    expect(profileFor({ host: "erp.local", port: 3307 }, [erp])).toBeUndefined();
    endpoint({ driver: "mysql", host: "erp.local", port: 3306 });
    expect((screen.getByRole("radio", { name: "A saved connection" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });
});

describe("NamePicker", () => {
  function picker(value: string[] | undefined, catalog: string[] | null) {
    const onChange = vi.fn();
    render(
      <NamePicker
        label="Tables and views"
        allLabel="Every one"
        allExplain="Every table"
        emptyLabel="None picked"
        value={value}
        catalog={catalog}
        catalogLoading={false}
        catalogSource="ERP"
        readOnly={false}
        onChange={onChange}
      />,
    );
    return onChange;
  }

  it("adds a name from the catalog", () => {
    const onChange = picker([], ["clientes", "facturas"]);
    fireEvent.click(screen.getByLabelText("facturas"));
    expect(onChange).toHaveBeenCalledWith(["facturas"]);
  });

  it("says what a typed pattern matches before it is added", () => {
    const onChange = picker([], ["v_factura_2024", "v_factura_2025", "clientes"]);
    const input = screen.getByLabelText("Add a pattern");
    fireEvent.change(input, { target: { value: "v_factura_*" } });
    expect(screen.getByText(/Matches 2: v_factura_2024, v_factura_2025/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["v_factura_*"]);
  });

  it("keeps 'every' and 'none' apart", () => {
    const onChange = picker(undefined, null);
    expect(screen.getByText("Every table")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Only these" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("matches the backend's one wildcard, case-insensitively", () => {
    expect(matchesOf("V_*", ["v_a", "x_v"])).toEqual(["v_a"]);
    expect(matchesOf("a?c", ["abc", "a?c"])).toEqual(["a?c"]);
  });
});
