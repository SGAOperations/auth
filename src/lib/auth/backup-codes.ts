import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";

// The twoFactor plugin's "encrypted" storage is reversible. These codes are
// stored as keyed hashes instead, so a database read never yields a usable code.

export const BACKUP_CODE_HASH_PREFIX = "h1:";

const codeList = z.array(z.string());

/** `h1:` plus the hex HMAC-SHA256 of the trimmed code, keyed by the auth secret. */
export function hashBackupCode(secret: string, code: string): string {
  const digest = createHmac("sha256", secret).update(code.trim()).digest("hex");
  return `${BACKUP_CODE_HASH_PREFIX}${digest}`;
}

/**
 * `backupCodeOptions.storeBackupCodes`. `encrypt` receives the JSON the plugin
 * wants stored: fresh plaintext codes at generation, or already-hashed ones
 * after a code is used, so only entries without the prefix are hashed.
 * `decrypt` is the identity, because the plugin compares against a hashed
 * submission (see the sgauth-mfa plugin).
 */
export function hashedBackupCodeStorage(secret: string) {
  return {
    encrypt: async (json: string) => {
      const codes = codeList.parse(JSON.parse(json));
      return JSON.stringify(
        codes.map((code) =>
          code.startsWith(BACKUP_CODE_HASH_PREFIX)
            ? code
            : hashBackupCode(secret, code),
        ),
      );
    },
    decrypt: async (stored: string) => stored,
  };
}
