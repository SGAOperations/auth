import { createHmac, timingSafeEqual } from "node:crypto";

// Pure TOTP (RFC 4226 and RFC 6238). Better Auth's twoFactor plugin verifies
// codes itself but reports no matched step, which replay rejection needs. These
// constants match the plugin defaults in @better-auth/utils/otp.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const CODE_PATTERN = new RegExp(`^\\d{${TOTP_DIGITS}}$`);

/**
 * HMAC-SHA1 one-time password. The key is the secret's UTF-8 bytes, which is
 * how the plugin keys it.
 */
export function hotp(
  secret: string,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(message)
    .digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const truncated =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

export function currentTotpStep(nowMs: number): number {
  return Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));
}

/**
 * The step `code` was generated for, within the accepted window, or null.
 * Checks every step with no early exit and returns the highest match.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  nowMs: number,
): number | null {
  if (!CODE_PATTERN.test(code)) return null;
  const given = Buffer.from(code, "utf8");
  const current = currentTotpStep(nowMs);
  let matched: number | null = null;
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    const expected = Buffer.from(hotp(secret, step), "utf8");
    if (timingSafeEqual(given, expected)) matched = step;
  }
  return matched;
}
