import "server-only";

// Pure: no env, no I/O. Rule ids are used verbatim in Redis keys, so renaming
// one resets its counters. Tune limits here and nowhere else.

export type RuleKey = "ip" | "email" | "session" | "user";

export interface Rule {
  id: string;
  limit: number;
  windowSeconds: number;
  by: RuleKey;
}

export const POLICIES = {
  signIn: [
    { id: "sign-in:ip:1m", limit: 10, windowSeconds: 60, by: "ip" },
    { id: "sign-in:ip:1h", limit: 50, windowSeconds: 3600, by: "ip" },
  ],
  signUp: [{ id: "sign-up:ip:1h", limit: 5, windowSeconds: 3600, by: "ip" }],
  passwordReset: [
    { id: "reset:ip:10m", limit: 3, windowSeconds: 600, by: "ip" },
    { id: "reset:email:10m", limit: 3, windowSeconds: 600, by: "email" },
  ],
  verificationResend: [
    { id: "verify:email:1h", limit: 3, windowSeconds: 3600, by: "email" },
  ],
  token: [
    { id: "token:session:1m", limit: 60, windowSeconds: 60, by: "session" },
  ],
  // Only src/lib/sgauth-session/server.ts uses this, through an in-memory
  // limiter, per instance. Never send it to Redis: the endpoint is a hot path.
  sessionLookup: [
    {
      id: "session-lookup:session:1m",
      limit: 120,
      windowSeconds: 60,
      by: "session",
    },
  ],
  // POST /<token-link>/confirm, for the emailed-link pages.
  tokenLink: [
    { id: "token-link:ip:10m", limit: 20, windowSeconds: 600, by: "ip" },
  ],
  reauth: [{ id: "reauth:user:1m", limit: 5, windowSeconds: 60, by: "user" }],
  // Checked in the Better Auth `before` hook (src/lib/auth/password-change.ts),
  // not by matchAuthRoute: the user id is known only after the session lookup.
  // Above the 5-failure lockout on purpose, so the lock trips first on guessing.
  changePassword: [
    {
      id: "change-password:user:10m",
      limit: 10,
      windowSeconds: 600,
      by: "user",
    },
  ],
  adminMutation: [
    { id: "admin:user:1m", limit: 100, windowSeconds: 60, by: "user" },
  ],
  // GET /api/sgauth/admin/audit/export: each call streams up to 50,000 rows.
  adminExport: [
    { id: "admin-export:user:10m", limit: 10, windowSeconds: 600, by: "user" },
  ],
  // The email step and the expired-link form. Per-email buckets count whether
  // or not the account exists, so a 429 is identical either way.
  setPasswordRequest: [
    { id: "set-password:ip:10m", limit: 10, windowSeconds: 600, by: "ip" },
    { id: "set-password:email:10m", limit: 5, windowSeconds: 600, by: "email" },
  ],
  // Links emailed to one account: 3 an hour (AUTH-T22).
  setPasswordLink: [
    {
      id: "set-password-link:user:1h",
      limit: 3,
      windowSeconds: 3600,
      by: "user",
    },
  ],
  // Admin invites to one user: 3 a day (AUTH-T22).
  setPasswordInvite: [
    { id: "invite:user:1d", limit: 3, windowSeconds: 86400, by: "user" },
  ],
} as const satisfies Record<string, readonly Rule[]>;

export type PolicyName = keyof typeof POLICIES;

/**
 * Maps a Better Auth route to its policy. `path` is the pathname with the
 * `/api/auth` prefix and any trailing slash removed. Exact matches only, and
 * the session endpoint is deliberately absent: it is the hot path and is never
 * Redis-limited.
 */
export function matchAuthRoute(
  method: string,
  path: string,
): PolicyName | null {
  const verb = method.toUpperCase();
  if (path === "/token") return "token";
  if (verb !== "POST") return null;
  switch (path) {
    case "/sign-in/email":
    // The second factor shares the sign-in IP budget, on top of the plugin's
    // own per-challenge and per-account caps.
    case "/two-factor/verify-totp":
    case "/two-factor/verify-backup-code":
      return "signIn";
    case "/sign-up/email":
      return "signUp";
    case "/request-password-reset":
      return "passwordReset";
    case "/send-verification-email":
      return "verificationResend";
    default:
      return null;
  }
}
