import "server-only";
import { passkey } from "@better-auth/passkey";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import type { PrismaClient } from "@/generated/prisma/client";
import { hashedBackupCodeStorage } from "@/lib/auth/backup-codes";
import { emailOtpPlugin, type EmailOtpInput } from "@/lib/auth/email-otp";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import { totpIssuer } from "@/lib/auth/mfa-policy";
import { sgauthMfa } from "@/lib/auth/mfa-plugin";
import { passkeyGuard } from "@/lib/auth/passkey-guard-plugin";
import { sgauthReauth } from "@/lib/auth/reauth-plugin";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
import type { SignupAllowlist } from "@/lib/auth/signup-allowlist";
import type { Mailer } from "@/lib/email/mailer";
import type { SgauthEnv } from "@/lib/env-schema";

interface PasskeySettings {
  rpID: string;
  rpName: string;
  origin: string;
}

/**
 * The stock passkey plugin and SGAuth's guard. `residentKey` is required so
 * sign-in needs no email first (and browser autofill works), and user
 * verification is required at enrollment. The guard checks the verification
 * flag again at sign-in.
 */
export function buildPasskeyPlugins(
  settings: PasskeySettings,
  prisma: PrismaClient,
) {
  return [
    passkey({
      rpID: settings.rpID,
      rpName: settings.rpName,
      origin: settings.origin,
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    }),
    passkeyGuard(prisma),
  ];
}

interface AuthPluginsInput {
  signupAllowlist: SignupAllowlist | null;
  passkey: PasskeySettings;
  prisma: PrismaClient;
  /** The environment's base URL, which is the JWT issuer. */
  issuer: string;
  /** The auth secret; keys the backup-code hashes. */
  secret: string;
  sgauthEnv: SgauthEnv;
  /** Sends the lock emails when a failed re-auth takes the account lock. */
  mailer: Mailer;
  /**
   * The emailed sign-in code plugin, or null while SGAUTH_EMAIL_OTP_ENABLED is
   * off. Off means the plugin is not registered at all, so its routes 404.
   */
  emailOtp?: EmailOtpInput | null;
}

/**
 * The plugin list of the live auth instance. The audit coverage test builds
 * its endpoint table from the same list, so a plugin added here is covered.
 */
export function buildAuthPlugins({
  signupAllowlist: list,
  passkey: passkeySettings,
  prisma,
  issuer,
  secret,
  sgauthEnv,
  mailer,
  emailOtp,
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
    // After sgauthMfa, so its admin refusal on /two-factor/disable answers
    // before the re-auth prompt does.
    sgauthReauth({
      prisma,
      sgauthEnv,
      mailer,
      linkOrigin: new URL(issuer).origin,
      secret,
    }),
    // After sgauthReauth, so its re-auth prompt on enrollment and removal
    // answers before the guard's cap does.
    ...buildPasskeyPlugins(passkeySettings, prisma),
    ...(emailOtp ? [emailOtpPlugin(emailOtp)] : []),
    // nextCookies must stay the last plugin.
    nextCookies(),
  ];
}
