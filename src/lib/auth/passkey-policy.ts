import { z } from "zod";

// Client-safe on purpose: no env, no DB. The rules the passkey guard plugin
// enforces on the server, in one place so each has a unit test. Re-auth is not
// here: the sgauth-reauth plugin gates the passkey paths through
// FRESH_AUTH_AUTH_PATHS and answers with REAUTH_REQUIRED.

export const MAX_PASSKEYS_PER_USER = 10;
export const PASSKEY_NAME_MAX_LENGTH = 64;

/**
 * A passkey label: trimmed, 1 to 64 characters, and optional. Blank input
 * becomes `undefined`, so a whitespace-only name is the same as none.
 */
export const passkeyNameSchema = z
  .string()
  .trim()
  .max(PASSKEY_NAME_MAX_LENGTH, "Use 64 characters or fewer.")
  .optional()
  .transform((name) => (name ? name : undefined));

// The flags byte of the WebAuthn authenticator data follows the 32-byte RP ID
// hash. Bit 2 (0x04) is "user verified".
const AUTHENTICATOR_DATA_MIN_BYTES = 37;
const FLAGS_OFFSET = 32;
const USER_VERIFIED_FLAG = 0x04;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Whether the authenticator data (base64url, as the browser posts it) has the
 * user-verified flag set. Anything that is not well-formed is not verified.
 */
export function hasUserVerification(authenticatorDataB64url: string): boolean {
  if (!BASE64URL.test(authenticatorDataB64url)) return false;
  const padded = authenticatorDataB64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(authenticatorDataB64url.length / 4) * 4, "=");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  if (bytes.length < AUTHENTICATOR_DATA_MIN_BYTES) return false;
  return (bytes[FLAGS_OFFSET] & USER_VERIFIED_FLAG) !== 0;
}

export const PASSKEY_ERROR_CODES = {
  PASSKEY_LIMIT_REACHED: {
    code: "PASSKEY_LIMIT_REACHED",
    message: `You've reached the limit of ${MAX_PASSKEYS_PER_USER} passkeys. Remove one to add another.`,
  },
  PASSKEY_USER_VERIFICATION_REQUIRED: {
    code: "PASSKEY_USER_VERIFICATION_REQUIRED",
    message: "That passkey couldn't be used. Try again, or use your password.",
  },
  INVALID_PASSKEY_NAME: {
    code: "INVALID_PASSKEY_NAME",
    message: `Use a name of ${PASSKEY_NAME_MAX_LENGTH} characters or fewer.`,
  },
} as const;
