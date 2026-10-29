import { describe, expect, it } from "vitest";
import {
  dailyCapReached,
  otpEligibility,
  type OtpUser,
} from "@/lib/auth/email-otp-policy";

const eligible: OtpUser = {
  status: "ACTIVE",
  emailVerified: true,
  isAdmin: false,
  isPrimaryAdmin: false,
  twoFactorEnabled: false,
};

describe("otpEligibility", () => {
  it("accepts an active, verified, non-admin account without MFA", () => {
    expect(otpEligibility(eligible, false)).toBe("ok");
  });

  it("treats a null twoFactorEnabled as no MFA", () => {
    expect(otpEligibility({ ...eligible, twoFactorEnabled: null }, false)).toBe(
      "ok",
    );
  });

  it("refuses an unknown account", () => {
    expect(otpEligibility(null, false)).toBe("no_account");
  });

  it.each(["DEACTIVATED", "DELETED"])("refuses status %s", (status) => {
    expect(otpEligibility({ ...eligible, status }, false)).toBe("inactive");
  });

  it("refuses an unverified account", () => {
    expect(otpEligibility({ ...eligible, emailVerified: false }, false)).toBe(
      "unverified",
    );
  });

  it("refuses an admin", () => {
    expect(otpEligibility({ ...eligible, isAdmin: true }, false)).toBe("admin");
  });

  it("refuses the Primary Admin", () => {
    expect(otpEligibility({ ...eligible, isPrimaryAdmin: true }, false)).toBe(
      "admin",
    );
  });

  it("refuses an account with MFA", () => {
    expect(otpEligibility({ ...eligible, twoFactorEnabled: true }, false)).toBe(
      "mfa",
    );
  });

  it("refuses a locked account that has no known-device exemption", () => {
    expect(otpEligibility(eligible, true)).toBe("locked");
  });

  it("accepts an account whose lock a known device is exempt from", () => {
    // The caller passes `false` when the device cookie exempts this browser.
    expect(otpEligibility(eligible, false)).toBe("ok");
  });

  it("names the account-state refusal before the lock", () => {
    expect(otpEligibility({ ...eligible, isAdmin: true }, true)).toBe("admin");
  });
});

describe("dailyCapReached", () => {
  it("allows every send up to the cap", () => {
    expect(dailyCapReached(1, 100)).toBe(false);
    expect(dailyCapReached(100, 100)).toBe(false);
  });

  it("refuses the send after the cap", () => {
    expect(dailyCapReached(101, 100)).toBe(true);
  });
});
