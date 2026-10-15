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
  reauth: [{ id: "reauth:user:1m", limit: 5, windowSeconds: 60, by: "user" }],
  adminMutation: [
    { id: "admin:user:1m", limit: 100, windowSeconds: 60, by: "user" },
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
