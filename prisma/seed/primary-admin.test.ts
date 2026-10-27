import { describe, expect, it } from "vitest";
import {
  PrimaryAdminSeedError,
  formatPrimaryAdminSummary,
  planPrimaryAdmin,
  type PrimaryAdminState,
} from "./primary-admin";

const input = {
  email: "admin@example.com",
  password: "correct-horse-battery",
  name: "Local Primary Admin",
};

const seeded: PrimaryAdminState["target"] = {
  id: "u1",
  isAdmin: true,
  isPrimaryAdmin: true,
  emailVerified: true,
  status: "ACTIVE",
};

const types = (state: PrimaryAdminState) =>
  planPrimaryAdmin(state, input).actions.map((action) => action.type);

describe("planPrimaryAdmin", () => {
  it("creates the user and a credential when neither exists", () => {
    expect(types({ target: null, hasCredential: false, others: [] })).toEqual([
      "create-user",
      "create-credential",
    ]);
  });

  it("promotes an admin that is not yet the Primary Admin", () => {
    const target = { ...seeded, isPrimaryAdmin: false, emailVerified: false };
    expect(types({ target, hasCredential: false, others: [] })).toEqual([
      "promote",
      "create-credential",
    ]);
  });

  it("demotes another Primary Admin before promoting or creating", () => {
    const others = [{ id: "u2", email: "other@example.com" }];
    expect(types({ target: null, hasCredential: true, others })).toEqual([
      "demote-other",
      "create-user",
    ]);
    const target = { ...seeded, isPrimaryAdmin: false };
    expect(types({ target, hasCredential: true, others })).toEqual([
      "demote-other",
      "promote",
    ]);
  });

  it("plans nothing for a fully seeded user", () => {
    const state = { target: seeded, hasCredential: true, others: [] };
    const plan = planPrimaryAdmin(state, input);
    expect(plan.actions).toEqual([]);
    expect(formatPrimaryAdminSummary(input.email, plan)).toContain(
      "already seeded; nothing changed.",
    );
  });

  it("never replaces an existing password", () => {
    const state = { target: seeded, hasCredential: true, others: [] };
    const plan = planPrimaryAdmin(state, input);
    expect(plan.actions.map((action) => action.type)).not.toContain(
      "create-credential",
    );
    expect(formatPrimaryAdminSummary(input.email, plan)).toContain(
      "SEED_PRIMARY_ADMIN_PASSWORD was not applied.",
    );
  });

  it("refuses a target that is not ACTIVE, naming the status", () => {
    const target = { ...seeded, status: "DEACTIVATED" };
    const state = { target, hasCredential: true, others: [] };
    expect(() => planPrimaryAdmin(state, input)).toThrow(PrimaryAdminSeedError);
    expect(() => planPrimaryAdmin(state, input)).toThrow(/DEACTIVATED/);
  });

  it("never puts the password in a summary line", () => {
    const plan = planPrimaryAdmin(
      {
        target: null,
        hasCredential: false,
        others: [{ id: "u2", email: "other@example.com" }],
      },
      input,
    );
    const summary = formatPrimaryAdminSummary(input.email, plan);
    expect(summary).toContain("+ create Primary Admin admin@example.com");
    expect(summary).toContain("- clear Primary Admin from other@example.com");
    expect(summary).toContain("+ set password for admin@example.com");
    expect(summary).not.toContain(input.password);
  });
});
