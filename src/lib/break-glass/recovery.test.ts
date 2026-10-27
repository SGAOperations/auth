import { describe, expect, it } from "vitest";
import {
  RecoveryRefusal,
  formatRecoveryPlan,
  planRecovery,
  type RecoveryState,
} from "@/lib/break-glass/recovery";

type Target = NonNullable<RecoveryState["target"]>;

const oldPa = { id: "u-old", email: "old@northeastern.edu" };

function user(overrides: Partial<Target> = {}): Target {
  return {
    id: "u-new",
    email: "new@northeastern.edu",
    status: "ACTIVE",
    isAdmin: true,
    isPrimaryAdmin: false,
    emailVerified: true,
    twoFactorEnabled: true,
    twoFactorRows: 1,
    ...overrides,
  };
}

function state(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return {
    target: user(),
    primaryAdmin: oldPa,
    inFlightTransfer: null,
    primaryAdminSessions: 3,
    targetSessions: 1,
    ...overrides,
  };
}

const transfer = {
  mode: "transfer",
  email: "new@northeastern.edu",
  demotePrevious: false,
} as const;
const reset = {
  mode: "reset_mfa",
  email: "pa@northeastern.edu",
  demotePrevious: false,
} as const;

describe("planRecovery: refusals", () => {
  it("refuses an unknown user in both modes", () => {
    for (const input of [transfer, reset]) {
      expect(() => planRecovery(state({ target: null }), input)).toThrow(
        `No user with email ${input.email}.`,
      );
    }
  });

  it.each(["DEACTIVATED", "DELETED"] as const)(
    "refuses a %s user in both modes",
    (status) => {
      const target = user({ status, isPrimaryAdmin: true });
      for (const input of [transfer, reset]) {
        expect(() => planRecovery(state({ target }), input)).toThrow(
          `new@northeastern.edu is ${status}; break-glass only promotes an ACTIVE user.`,
        );
      }
    },
  );

  it("refuses to transfer to the Primary Admin", () => {
    const target = user({ isPrimaryAdmin: true });
    expect(() => planRecovery(state({ target }), transfer)).toThrow(
      "new@northeastern.edu is already the Primary Admin. To recover their MFA use --reset-mfa.",
    );
  });

  it("refuses an MFA reset for someone who is not the Primary Admin", () => {
    expect(() => planRecovery(state(), reset)).toThrow(
      "new@northeastern.edu is not the Primary Admin. Admins reset other users' MFA in the admin UI.",
    );
  });

  it("refuses an MFA reset when nothing is enrolled", () => {
    const target = user({
      isPrimaryAdmin: true,
      twoFactorEnabled: false,
      twoFactorRows: 0,
    });
    expect(() => planRecovery(state({ target }), reset)).toThrow(
      "new@northeastern.edu has no MFA enrolled; nothing to reset.",
    );
  });

  it("throws RecoveryRefusal so the script can show it without a stack", () => {
    expect(() => planRecovery(state({ target: null }), transfer)).toThrow(
      RecoveryRefusal,
    );
  });
});

describe("planRecovery: transfer", () => {
  it("clears the old Primary Admin first, then promotes, then signs out", () => {
    const plan = planRecovery(state(), transfer);
    expect(plan.mode).toBe("transfer");
    expect(plan.actions).toEqual([
      {
        kind: "clear_primary_admin",
        userId: "u-old",
        email: oldPa.email,
        revokeAdmin: false,
      },
      { kind: "promote", userId: "u-new", email: "new@northeastern.edu" },
      { kind: "sign_out", userId: "u-old", email: oldPa.email, sessions: 3 },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("cancels an in-flight transfer before anything else", () => {
    const plan = planRecovery(
      state({ inFlightTransfer: { id: "t1", status: "COOLING" } }),
      transfer,
    );
    expect(plan.actions[0]).toEqual({
      kind: "cancel_transfer",
      transferId: "t1",
      status: "COOLING",
    });
  });

  it("revokes the old admin flag with --demote-previous", () => {
    const plan = planRecovery(state(), { ...transfer, demotePrevious: true });
    expect(plan.actions[0]).toMatchObject({
      kind: "clear_primary_admin",
      revokeAdmin: true,
    });
  });

  it("warns about a missing MFA, an unverified email, a non-admin and no current Primary Admin", () => {
    const plan = planRecovery(
      state({
        primaryAdmin: null,
        target: user({
          isAdmin: false,
          emailVerified: false,
          twoFactorEnabled: false,
          twoFactorRows: 0,
        }),
      }),
      transfer,
    );
    expect(plan.actions).toEqual([
      { kind: "promote", userId: "u-new", email: "new@northeastern.edu" },
    ]);
    expect(plan.warnings).toHaveLength(4);
    expect(plan.warnings.join("\n")).toMatch(/no current Primary Admin/);
    expect(plan.warnings.join("\n")).toMatch(/must enrol TOTP/);
  });
});

describe("planRecovery: reset MFA", () => {
  const paState = () =>
    state({
      target: user({
        id: "u-pa",
        email: "pa@northeastern.edu",
        isPrimaryAdmin: true,
      }),
      targetSessions: 2,
    });

  it("removes the enrolment, then signs the Primary Admin out", () => {
    expect(planRecovery(paState(), reset).actions).toEqual([
      { kind: "remove_mfa", userId: "u-pa", email: "pa@northeastern.edu" },
      {
        kind: "sign_out",
        userId: "u-pa",
        email: "pa@northeastern.edu",
        sessions: 2,
      },
    ]);
  });
});

describe("formatRecoveryPlan", () => {
  it("prints one line per action, then the warnings", () => {
    const plan = planRecovery(
      state({
        inFlightTransfer: { id: "t1", status: "COOLING" },
        target: user({ twoFactorEnabled: false, twoFactorRows: 0 }),
      }),
      transfer,
    );
    expect(formatRecoveryPlan(plan)).toBe(
      [
        "Break-glass: transfer Primary Admin",
        "! cancel in-flight transfer t1 (COOLING)",
        "- clear Primary Admin from old@northeastern.edu (stays admin)",
        "+ make new@northeastern.edu admin and Primary Admin",
        "x sign out old@northeastern.edu (3 sessions)",
        "warning: new@northeastern.edu has no MFA; they must enrol TOTP before any admin action",
      ].join("\n"),
    );
  });

  it("says admin revoked and singular session", () => {
    const plan = planRecovery(state({ primaryAdminSessions: 1 }), {
      ...transfer,
      demotePrevious: true,
    });
    const text = formatRecoveryPlan(plan);
    expect(text).toContain("(admin revoked)");
    expect(text).toContain("(1 session)");
  });

  it("formats the MFA reset", () => {
    const plan = planRecovery(
      state({
        target: user({ email: "pa@northeastern.edu", isPrimaryAdmin: true }),
        targetSessions: 0,
      }),
      reset,
    );
    expect(formatRecoveryPlan(plan)).toBe(
      [
        "Break-glass: reset Primary Admin MFA",
        "x remove TOTP and backup codes for pa@northeastern.edu",
        "x sign out pa@northeastern.edu (0 sessions)",
      ].join("\n"),
    );
  });
});
