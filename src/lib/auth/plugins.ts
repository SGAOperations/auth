import "server-only";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import type { PrismaClient } from "@/generated/prisma/client";
import { hashedBackupCodeStorage } from "@/lib/auth/backup-codes";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import { totpIssuer } from "@/lib/auth/mfa-policy";
import { sgauthMfa } from "@/lib/auth/mfa-plugin";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
import type { SignupAllowlist } from "@/lib/auth/signup-allowlist";
import type { SgauthEnv } from "@/lib/env-schema";

interface AuthPluginsInput {
  signupAllowlist: SignupAllowlist | null;
  prisma: PrismaClient;
  /** The environment's base URL, which is the JWT issuer. */
  issuer: string;
  /** The auth secret; keys the backup-code hashes. */
  secret: string;
  sgauthEnv: SgauthEnv;
}

/**
 * The plugin list of the live auth instance. The audit coverage test builds
 * its endpoint table from the same list, so a plugin added here is covered.
 */
export function buildAuthPlugins({
  signupAllowlist: list,
  prisma,
  issuer,
  secret,
  sgauthEnv,
}: AuthPluginsInput) {
  return [
    ...(list ? [signupAllowlist(list)] : []),
    buildJwtPlugin({ prisma, issuer }),
    // TOTP and backup codes only: no `otpOptions`, so email and SMS codes stay
    // unavailable. No `skipVerificationOnEnable` and no `allowPasswordless`, so
    // enable, disable, get-URI and regenerate all require the password. The
    // account lockout stays at its default (10 failures, 15 minutes).
    twoFactor({
      issuer: totpIssuer(sgauthEnv),
      backupCodeOptions: { storeBackupCodes: hashedBackupCodeStorage(secret) },
    }),
    sgauthMfa({ prisma, secret }),
    // nextCookies must stay the last plugin.
    nextCookies(),
  ];
}
