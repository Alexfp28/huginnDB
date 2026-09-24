/**
 * @vitest-environment jsdom
 *
 * Settings → Policy renders what `policy_status` reports, for each state a
 * machine can be in. The panel is read-only, so the tests are about what a
 * user is *told*: who they are, which role, what each connection allows, and
 * — the case that matters most — that a broken policy blocks the AI.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { PolicySection } from "./PolicySection";
import type { PolicyStatus } from "@/types";

const policyStatus = vi.fn<() => Promise<PolicyStatus>>();

vi.mock("@/lib/tauri", () => ({
  api: { policyStatus: () => policyStatus() },
}));

afterEach(() => {
  cleanup();
  policyStatus.mockReset();
});

function status(over: Partial<PolicyStatus> = {}): PolicyStatus {
  return {
    state: "active",
    source: "\\\\srv\\it\\huginn.json (named by C:\\Program Files\\HuginnDB\\managed-policy.json)",
    error: null,
    warnings: [],
    user: "ana",
    role: "sales",
    unmanagedConnections: "deny",
    connections: [
      {
        id: "erp",
        name: "ERP",
        unmatched: false,
        leftAlone: false,
        rules: [
          {
            databases: ["billing"],
            allow: ["invoices", "v_invoice_*"],
            deny: ["v_invoice_cards"],
            human: ["select", "insert", "update"],
            ai: ["select"],
            freeSql: false,
          },
        ],
      },
      { id: "hr", name: "HR", unmatched: true, leftAlone: false, rules: [] },
    ],
    ...over,
  };
}

describe("PolicySection", () => {
  it("shows the account, the role and what each connection allows", async () => {
    policyStatus.mockResolvedValue(status());
    render(<PolicySection />);

    expect(await screen.findByText("sales")).toBeTruthy();
    expect(screen.getByText("ana")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("ERP")).toBeTruthy();
    expect(screen.getByText("billing")).toBeTruthy();
    expect(screen.getByText("invoices, v_invoice_*")).toBeTruthy();
    expect(screen.getByText("v_invoice_cards")).toBeTruthy();
    // What the AI gets and what the person gets, told apart.
    expect(screen.getByText("select")).toBeTruthy();
    expect(screen.getByText("select, insert, update")).toBeTruthy();
    expect(screen.getByText(/^disabled/)).toBeTruthy();
    // A connection no rule names is out of the AI's reach under `deny`.
    expect(screen.getByText(/the AI cannot use it/)).toBeTruthy();
    // And the panel is honest about phase 1.
    expect(screen.getByText(/applies the policy to the AI only/)).toBeTruthy();
  });

  it("says a broken policy blocks the AI, and why", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "broken",
        error: "the policy is not valid: unknown field `relatons`",
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Could not be applied")).toBeTruthy();
    expect(screen.getByText(/the AI is blocked on every connection/)).toBeTruthy();
    expect(screen.getByText(/unknown field `relatons`/)).toBeTruthy();
    // Nothing about connections is shown when there is no policy in force.
    expect(screen.queryByText("ERP")).toBeNull();
  });

  it("explains an unmanaged machine instead of showing an empty table", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "unmanaged",
        source: null,
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Not managed")).toBeTruthy();
    expect(screen.getByText(/HKLM\\SOFTWARE\\Policies\\HuginnDB/)).toBeTruthy();
  });

  it("surfaces the warnings a valid policy carries", async () => {
    policyStatus.mockResolvedValue(
      status({
        warnings: [
          'role "sales", rule 1: `ai` grants something `human` does not; the AI never gets more than the person, so the extra is ignored',
        ],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Warnings")).toBeTruthy();
    expect(screen.getByText(/the extra is ignored/)).toBeTruthy();
  });
});
