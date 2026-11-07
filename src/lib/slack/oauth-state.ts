import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

// The state of a Slack redirect flow, shared by Connect Slack (#314) and the
// title-update consent (#358). A state is a random value whose hash keys a
// single-use Verification row for one user, and a cookie of the same value binds
// it to the browser that started the flow. The two flows use different
// identifier prefixes, so a state from one can never finish the other.

const baseURL = toAuthSettings(env).baseURL;

/** Ten minutes to finish the flow on Slack. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const SLACK_STATE_COOKIE_MAX_AGE = OAUTH_STATE_TTL_MS / 1000;

export type SlackFlow = "connect" | "consent";

export const OAUTH_STATE_PREFIX: Record<SlackFlow, string> = {
  connect: "slack-openid:",
  consent: "slack-consent:",
};

const COOKIE_NAMES: Record<SlackFlow, string> = {
  connect: "slack-state",
  consent: "slack-consent-state",
};

const isHttps = () => new URL(baseURL).protocol === "https:";

/** The cookie that binds a flow to the browser that started it. */
export const stateCookieName = (flow: SlackFlow): string =>
  `${isHttps() ? "__Host-" : ""}sgauth.${COOKIE_NAMES[flow]}`;

export const stateCookieSecure = (): boolean => isHttps();

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * The identifier a stored state is keyed by. It is keyed with the auth secret,
 * so a leaked Verification table alone cannot be turned into valid states. The
 * state is 256 random bits, so this is an index key, not a password hash.
 */
const stateDigest = (state: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(state).digest("hex");

export function sameString(a: string, b: string): boolean {
  const left = Buffer.from(sha256Hex(a), "hex");
  const right = Buffer.from(sha256Hex(b), "hex");
  return timingSafeEqual(left, right);
}

/**
 * Stores a fresh state for `userId`, with `extra` kept beside the user id, and
 * returns the state for the browser-binding cookie.
 */
export async function createOAuthState(
  prefix: string,
  userId: string,
  extra: Record<string, string> = {},
  now: Date = new Date(),
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await prisma.verification.create({
    data: {
      identifier: `${prefix}${stateDigest(state)}`,
      value: JSON.stringify({ userId, ...extra }),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
  });
  return state;
}

/**
 * Spends a state. It must match the cookie of the browser that started the flow
 * and belong to `userId`; it is single-use, so a replay finds nothing. Returns
 * the stored values, or null for any failure.
 */
export async function consumeOAuthState(
  prefix: string,
  state: string,
  cookieState: string | undefined,
  userId: string,
  now: Date = new Date(),
): Promise<Record<string, unknown> | null> {
  if (!cookieState || !sameString(state, cookieState)) return null;

  const row = await prisma.verification.findFirst({
    where: {
      identifier: `${prefix}${stateDigest(state)}`,
      expiresAt: { gt: now },
    },
    select: { id: true, value: true },
  });
  if (!row) return null;
  // Single use, whatever happens next.
  const { count } = await prisma.verification.deleteMany({
    where: { id: row.id },
  });
  if (count !== 1) return null;

  let stored: unknown;
  try {
    stored = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("userId" in stored) ||
    stored.userId !== userId
  ) {
    return null;
  }
  return stored as Record<string, unknown>;
}
