import { describe, expect, it } from "vitest";
import {
  currentTotpStep,
  hotp,
  matchTotpStep,
  TOTP_PERIOD_SECONDS,
} from "@/lib/auth/totp";

// RFC 6238 appendix B, SHA-1 secret, reduced to six digits.
const SECRET = "12345678901234567890";

describe("hotp and currentTotpStep", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
  ])("matches the RFC 6238 vector at T=%i", (seconds, code) => {
    const step = currentTotpStep(seconds * 1000);
    expect(hotp(SECRET, step)).toBe(code);
  });

  it("uses a 30 second step", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(currentTotpStep(29_999)).toBe(0);
    expect(currentTotpStep(30_000)).toBe(1);
  });
});

describe("matchTotpStep", () => {
  const now = 1234567890 * 1000;
  const step = currentTotpStep(now);

  it.each([-1, 0, 1])(
    "matches a code %i steps away and returns its step",
    (offset) => {
      expect(matchTotpStep(SECRET, hotp(SECRET, step + offset), now)).toBe(
        step + offset,
      );
    },
  );

  it.each([-2, 2])("rejects a code %i steps away", (offset) => {
    expect(matchTotpStep(SECRET, hotp(SECRET, step + offset), now)).toBeNull();
  });

  it.each(["12345", "1234567", "abcdef", " 287082", "28708 ", ""])(
    "rejects the malformed code %j",
    (code) => {
      expect(matchTotpStep(SECRET, code, 59_000)).toBeNull();
    },
  );

  it("rejects a code made with another secret", () => {
    expect(
      matchTotpStep(SECRET, hotp("another-secret-value", step), now),
    ).toBeNull();
  });
});
