import { z } from "zod";
import { MFA_ERROR_CODES } from "@/lib/auth/mfa-policy";
import {
  AUTH_ERROR_CODES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/policy";
import { REAUTH_ERROR_CODES } from "@/lib/auth/reauth-policy";

// Client-safe on purpose: no env, no DB, no `server-only`. The security page's
// client components and its tests share these helpers.

export const SECURITY_PATH = "/account/security";
export const SECURITY_SIGN_IN_PATH = `/login?redirect=${encodeURIComponent(SECURITY_PATH)}`;
export const BACKUP_CODES_FILE_NAME = "sgauth-backup-codes.txt";
export const LOW_BACKUP_CODES = 2;

export const searchParamsSchema = z.object({
  reason: z.enum(["mfa-required"]).optional(),
});

export type SecurityReason = z.infer<typeof searchParamsSchema>["reason"];

/** The `reason` query param, or undefined when absent or unknown. */
export function parseSecurityReason(raw: unknown): SecurityReason {
  const parsed = searchParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data.reason : undefined;
}

export const passwordOnlySchema = z.object({
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
});

export type PasswordOnlyValues = z.infer<typeof passwordOnlySchema>;

export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/** Strips the spaces and hyphens people type or paste into a code. */
export function normalizeTotpInput(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** The verify step's form: the raw input, checked after normalizing. */
export const verifyCodeSchema = z.object({
  code: z
    .string()
    .refine(
      (raw) => totpCodeSchema.safeParse(normalizeTotpInput(raw)).success,
      {
        message: "Enter the 6-digit code from your app.",
      },
    ),
});

export type VerifyCodeValues = z.infer<typeof verifyCodeSchema>;

export interface TotpUri {
  secret: string;
  issuer: string | null;
  account: string | null;
}

/** The parts of an `otpauth://totp/...` URI, or null for anything else. */
export function parseTotpUri(uri: string): TotpUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "otpauth:") return null;
  const secret = url.searchParams.get("secret");
  if (!secret) return null;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const separator = label.indexOf(":");
  return {
    secret,
    issuer: url.searchParams.get("issuer"),
    account: label ? label.slice(separator + 1).trim() || null : null,
  };
}

/** The key in blocks of four, for reading aloud or typing. Display only. */
export function groupKey(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? "";
}

export function backupCodesFileText(
  codes: readonly string[],
  { email, generatedAt }: { email: string; generatedAt: Date },
): string {
  return [
    `SGAuth backup codes for ${email}`,
    `Generated ${generatedAt.toISOString().slice(0, 10)}`,
    "Each code works once. Keep this file somewhere safe.",
    "",
    ...codes,
    "",
  ].join("\n");
}

export type SecurityErrorField = "password" | "code" | "newPassword";

export interface SecurityError {
  field?: SecurityErrorField;
  message: string;
  /** The page state is stale: refresh it. */
  refresh?: boolean;
  /** The session has ended: offer a sign-in link. */
  signedOut?: boolean;
}

const GENERIC = "Something went wrong. Try again.";
const BAD_CODE =
  "That code didn't work. Check your authenticator app and try again.";
const TOO_MANY_CODES =
  "Too many incorrect codes. Wait 15 minutes and try again.";

const byCode: Record<string, SecurityError> = {
  INVALID_PASSWORD: {
    field: "password",
    message: "That password is incorrect.",
  },
  PASSWORD_TOO_SHORT: {
    field: "newPassword",
    message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
  },
  PASSWORD_TOO_LONG: {
    field: "newPassword",
    message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
  },
  NEW_PASSWORD_SAME_AS_CURRENT: {
    field: "newPassword",
    message: AUTH_ERROR_CODES.NEW_PASSWORD_SAME_AS_CURRENT.message,
  },
  PASSWORD_CHANGE_LOCKED: {
    message: AUTH_ERROR_CODES.PASSWORD_CHANGE_LOCKED.message,
  },
  INVALID_CODE: { field: "code", message: BAD_CODE },
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: {
    field: "code",
    message: TOO_MANY_CODES,
  },
  ACCOUNT_TEMPORARILY_LOCKED: { field: "code", message: TOO_MANY_CODES },
  TOTP_ALREADY_ENABLED: {
    message: "Two-factor authentication is already on.",
    refresh: true,
  },
  TWO_FACTOR_NOT_ENABLED: {
    message: "Two-factor authentication is already off.",
    refresh: true,
  },
  [MFA_ERROR_CODES.MFA_REQUIRED_FOR_ADMIN.code]: {
    message: MFA_ERROR_CODES.MFA_REQUIRED_FOR_ADMIN.message,
    refresh: true,
  },
};

const errorBody = z.object({ code: z.string() });

/**
 * The message and field for a failed Better Auth response. Null when the
 * re-auth dialog was cancelled: the dialog already said what it needed to.
 */
export function securityErrorCopy(
  status: number,
  body: unknown,
): SecurityError | null {
  const parsed = errorBody.safeParse(body);
  const code = parsed.success ? parsed.data.code : null;
  if (code === REAUTH_ERROR_CODES.REAUTH_REQUIRED.code) return null;
  if (code && Object.hasOwn(byCode, code)) return byCode[code];
  if (status === 401) {
    return {
      message: "Your session has ended. Sign in again.",
      signedOut: true,
    };
  }
  if (status === 429) {
    return { message: "Too many attempts. Wait a minute and try again." };
  }
  return { message: GENERIC };
}

/** `securityErrorCopy` for a response, reading its JSON body when it has one. */
export async function readSecurityError(
  response: Response,
): Promise<SecurityError | null> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A body that is not JSON carries no code.
  }
  return securityErrorCopy(response.status, body);
}

export const NETWORK_ERROR: SecurityError = { message: GENERIC };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type PostResult =
  | { ok: true; body: unknown }
  | { ok: false; error: SecurityError | null };

/**
 * POSTs JSON to a Better Auth endpoint. `error` is null when the re-auth
 * dialog was cancelled, which needs no message of its own.
 */
export async function postSecurity(
  send: Fetcher,
  path: string,
  payload: Record<string, unknown>,
): Promise<PostResult> {
  let response: Response;
  try {
    response = await send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!response.ok)
    return { ok: false, error: await readSecurityError(response) };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A success with no JSON body carries nothing to read.
  }
  return { ok: true, body };
}

const enableBody = z.object({
  totpURI: z.string(),
  backupCodes: z.array(z.string()).min(1),
});

/** The enable response: the TOTP URI and the plaintext codes, shown once. */
export function parseEnableResponse(
  body: unknown,
): { totpURI: string; backupCodes: string[] } | null {
  const parsed = enableBody.safeParse(body);
  return parsed.success ? parsed.data : null;
}

const regenerateBody = z.object({ backupCodes: z.array(z.string()).min(1) });

export function parseRegenerateResponse(body: unknown): string[] | null {
  const parsed = regenerateBody.safeParse(body);
  return parsed.success ? parsed.data.backupCodes : null;
}

/** The "Backup codes left" line, or null when the count is unknown. */
export function backupCodesStatus(remaining: number | null): {
  summary: string;
  warning: string | null;
} | null {
  if (remaining === null) return null;
  const summary = `Backup codes left: ${remaining} of 10`;
  if (remaining === 0) {
    return {
      summary,
      warning: "You have no backup codes left. Generate new ones now.",
    };
  }
  if (remaining <= LOW_BACKUP_CODES) {
    return {
      summary,
      warning:
        "You're running low on backup codes. Generate new ones so you don't get locked out.",
    };
  }
  return { summary, warning: null };
}
