import { describe, expect, it } from "vitest";
import { FAILURE_CODES } from "@/lib/admin/action-result";
import {
  FAILURE_COPY,
  REASON_COPY,
  disabledReason,
  failureMessage,
  isDenialReason,
} from "@/lib/admin/denial-copy";

describe("denial copy", () => {
  it("has copy for every authorization reason", () => {
    for (const [reason, copy] of Object.entries(REASON_COPY)) {
      expect(copy.trim(), reason).not.toBe("");
    }
  });

  it("has copy for every failure code", () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_COPY[code].trim(), code).not.toBe("");
    }
  });

  it("explains a denial with its reason", () => {
    expect(
      failureMessage({
        ok: false,
        code: "FORBIDDEN",
        reason: "SELF_MODIFICATION",
      }),
    ).toBe(REASON_COPY.SELF_MODIFICATION);
  });

  it("shows the server's line for a conflict that carries one", () => {
    expect(
      failureMessage({
        ok: false,
        code: "CONFLICT",
        message: "Already admin.",
      }),
    ).toBe("Already admin.");
    expect(failureMessage({ ok: false, code: "CONFLICT" })).toBe(
      FAILURE_COPY.CONFLICT,
    );
  });

  it("explains a disabled control only when the action is denied", () => {
    expect(disabledReason({ allowed: true })).toBeNull();
    expect(disabledReason({ allowed: false, reason: "NOT_ADMIN" })).toBe(
      REASON_COPY.NOT_ADMIN,
    );
  });

  it("recognises only real reasons", () => {
    expect(isDenialReason("NOT_ADMIN")).toBe(true);
    expect(isDenialReason("toString")).toBe(false);
    expect(isDenialReason(undefined)).toBe(false);
  });
});
