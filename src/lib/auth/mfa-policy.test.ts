import { describe, expect, it } from "vitest";
import {
  MFA_ENROLLMENT_PATH,
  MFA_ERROR_CODES,
  adminMfaDecision,
  canDisableMfa,
  totpIssuer,
  transferRecipientDecision,
  type MfaSubject,
} from "@/lib/auth/mfa-policy";

const base: MfaSubject = {
  isAdmin: false,
  isPrimaryAdmin: false,
  twoFactorEnabled: false,
  status: "ACTIVE",
};

describe("adminMfaDecision", () => {
  it.each([
    ["deactivated", { status: "DEACTIVATED" }, "NOT_ACTIVE"],
    [
      "deactivated admin with MFA",
      { status: "DEACTIVATED", isAdmin: true, twoFactorEnabled: true },
      "NOT_ACTIVE",
    ],
    ["plain user", {}, "NOT_ADMIN"],
    ["plain user with MFA", { twoFactorEnabled: true }, "NOT_ADMIN"],
    ["admin without MFA", { isAdmin: true }, "MFA_REQUIRED"],
    [
      "Primary Admin without MFA",
      { isAdmin: true, isPrimaryAdmin: true },
      "MFA_REQUIRED",
    ],
  ] as const)("refuses a %s", (_name, patch, reason) => {
    expect(adminMfaDecision({ ...base, ...patch })).toEqual({
      allowed: false,
      reason,
    });
  });

  it.each([
    ["admin with MFA", { isAdmin: true, twoFactorEnabled: true }],
    [
      "Primary Admin with MFA",
      { isAdmin: true, isPrimaryAdmin: true, twoFactorEnabled: true },
    ],
  ] as const)("allows an %s", (_name, patch) => {
    expect(adminMfaDecision({ ...base, ...patch })).toEqual({ allowed: true });
  });
});

describe("canDisableMfa", () => {
  it("allows a plain user, with or without MFA", () => {
    expect(canDisableMfa(base)).toBe(true);
    expect(canDisableMfa({ ...base, twoFactorEnabled: true })).toBe(true);
  });

  it("refuses an admin and the Primary Admin", () => {
    expect(canDisableMfa({ ...base, isAdmin: true })).toBe(false);
    expect(
      canDisableMfa({ ...base, isAdmin: true, isPrimaryAdmin: true }),
    ).toBe(false);
  });
});

describe("transferRecipientDecision", () => {
  it.each([
    ["deactivated", { status: "DEACTIVATED" }, "NOT_ACTIVE"],
    ["not an admin", { twoFactorEnabled: true }, "NOT_ADMIN"],
    ["not enrolled", { isAdmin: true }, "MFA_REQUIRED"],
    [
      "already the Primary Admin",
      { isAdmin: true, isPrimaryAdmin: true, twoFactorEnabled: true },
      "ALREADY_PRIMARY_ADMIN",
    ],
  ] as const)("refuses a recipient who is %s", (_name, patch, reason) => {
    expect(transferRecipientDecision({ ...base, ...patch })).toEqual({
      allowed: false,
      reason,
    });
  });

  it("allows an enrolled admin who is not the Primary Admin", () => {
    expect(
      transferRecipientDecision({
        ...base,
        isAdmin: true,
        twoFactorEnabled: true,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("totpIssuer", () => {
  it("names the environment everywhere but production", () => {
    expect(totpIssuer("production")).toBe("SGAuth");
    expect(totpIssuer("dev")).toBe("SGAuth (dev)");
    expect(totpIssuer("preview")).toBe("SGAuth (preview)");
    expect(totpIssuer("local")).toBe("SGAuth (local)");
  });
});

describe("contract constants", () => {
  it("keeps the codes the clients map", () => {
    expect(MFA_ERROR_CODES.MFA_REQUIRED.code).toBe("MFA_REQUIRED");
    expect(MFA_ERROR_CODES.MFA_REQUIRED_FOR_ADMIN.code).toBe(
      "MFA_REQUIRED_FOR_ADMIN",
    );
    expect(MFA_ENROLLMENT_PATH).toBe("/account/security");
  });
});
