import { NextRequest } from "next/server";
import { expect } from "vitest";
import type { AuditEvent, User } from "@/generated/prisma/client";
import { toAuthSettings } from "@/lib/auth/settings";
import { createFreshAuthGuard } from "@/lib/auth/fresh-auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { createCapturingMailer } from "@/test/capturing-mailer";
import {
  createAdmin,
  createPrimaryAdmin,
  createSession,
  createUser,
} from "@/test/factories";

// Helpers for tests that call the live route modules end to end. They assume
// the file mocks, before importing any route:
//
//   @/lib/prisma            createRollbackPrisma, when the case needs a Primary Admin
//   @/lib/auth/server       authServerMock
//   @/lib/email/server      { mailer: captured, sendEmail: captured.sendEmail }
//   @/lib/rate-limit/server rateLimitServerMock
//   next/headers            nextHeadersMock
//
// Everything else is the production code: the guard, `can()`, the handlers,
// the audit writer and the transfer service.

/** The origin the app is configured for; token-link POSTs must come from it. */
export const BASE_URL = new URL(toAuthSettings(env).baseURL).origin;
export const API = `${BASE_URL}/api/sgauth/admin`;
export const CLIENT_IP = "203.0.113.7";

/** Every email a route or job sent. Clear it at the start of a case. */
export const captured = createCapturingMailer();

// Who the next request is from: set by `callRoute`, read by the session lookup.
const caller: { token: string | null } = { token: null };

type SessionLookup = {
  user: { id: string };
  session: { id: string };
};

/**
 * Stands in for Better Auth's `getSession`: the request is from whoever holds
 * the token, and only while that session row exists and has not expired. A
 * revoked or deleted session therefore answers 401, as in production.
 */
async function lookupSession(): Promise<SessionLookup | null> {
  if (!caller.token) return null;
  const row = await prisma.session.findUnique({
    where: { token: caller.token },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return { user: { id: row.userId }, session: { id: row.id } };
}

/** The mock for `@/lib/auth/server`: the real fresh-auth guard over `lookupSession`. */
export const authServerMock = {
  getSession: lookupSession,
  requireFreshAuth: createFreshAuthGuard({ getSession: lookupSession, prisma }),
};

/** The mock for `@/lib/rate-limit/server`: every limit allows. */
export const rateLimitServerMock = {
  limitRequest: async () => null,
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
};

/** The mock for `next/headers`, for `audit()` outside a Next request scope. */
export const nextHeadersMock = {
  headers: async () =>
    new Headers({ "x-real-ip": CLIENT_IP, "user-agent": "vitest" }),
};

export type Actor = {
  user: User;
  token: string;
  sessionId: string;
};

/** A session for `user` that has just re-authenticated. */
export async function signIn(user: User): Promise<Actor> {
  const session = await createSession(user, { lastReauthAt: new Date() });
  return { user, token: session.token, sessionId: session.id };
}

/**
 * Stamps the session as freshly re-authenticated at the (possibly faked) now.
 * A session that no longer exists is left alone.
 */
export async function markReauthFresh(actor: Actor): Promise<void> {
  await prisma.session.updateMany({
    where: { id: actor.sessionId },
    data: { lastReauthAt: new Date() },
  });
}

export const ACTOR_KINDS = [
  "unauthenticated",
  "user",
  "adminNoMfa",
  "deactivatedAdmin",
  "admin",
  "primaryAdmin",
] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const TARGET_KEYS = [
  "self",
  "otherUser",
  "otherAdmin",
  "primaryAdmin",
] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

export type World = {
  kind: ActorKind;
  /** Null for `unauthenticated`: no cookie is sent. */
  actor: Actor | null;
  targets: Record<TargetKey, User>;
};

async function actorUser(kind: ActorKind, primaryAdmin: User): Promise<User> {
  switch (kind) {
    case "primaryAdmin":
      return primaryAdmin;
    case "admin":
      return createAdmin({ twoFactorEnabled: true });
    case "adminNoMfa":
      return createAdmin({ twoFactorEnabled: false });
    case "deactivatedAdmin":
      return createAdmin({
        twoFactorEnabled: true,
        status: "DEACTIVATED",
        deactivatedAt: new Date(),
      });
    case "user":
    case "unauthenticated":
      return createUser({ twoFactorEnabled: true });
  }
}

/**
 * One actor and the four people it acts on, all created in the current
 * transaction. The Primary Admin is created here too, displacing the harness
 * one for this transaction only. Call it inside `withRollback`.
 *
 * The other user and the other admin both have MFA enrolled, so `reset-mfa`
 * reaches its authorization decision instead of `MFA_NOT_ENROLLED`.
 */
export async function buildWorld(kind: ActorKind): Promise<World> {
  const primaryAdmin = await createPrimaryAdmin(
    { twoFactorEnabled: true },
    prisma,
  );
  const self = await actorUser(kind, primaryAdmin);
  return {
    kind,
    actor: kind === "unauthenticated" ? null : await signIn(self),
    targets: {
      self,
      otherUser: await createUser({ twoFactorEnabled: true }),
      otherAdmin: await createAdmin({ twoFactorEnabled: true }),
      primaryAdmin,
    },
  };
}

type Params = Record<string, string>;

export type CallInit<P extends Params> = {
  method: string;
  url: string;
  /** Who is calling; omit for no session. */
  as?: Actor | null;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as a form post, for the emailed-link routes. */
  form?: Record<string, string>;
  params?: P;
  headers?: Record<string, string>;
};

export type CallResult = {
  status: number;
  headers: Headers;
  /** The parsed JSON body, or null when there is none. */
  body: unknown;
};

/**
 * Calls a route module's exported handler the way Next does: a `NextRequest`
 * with the app's own Origin, and `params` as a Promise (Next 16).
 */
export async function callRoute<P extends Params = Params>(
  handler: (
    request: NextRequest,
    ctx: { params: Promise<P> },
  ) => Promise<Response>,
  init: CallInit<P>,
): Promise<CallResult> {
  caller.token = init.as?.token ?? null;
  const headers = new Headers({
    origin: BASE_URL,
    "x-real-ip": CLIENT_IP,
    "user-agent": "vitest",
    ...init.headers,
  });
  let body: string | undefined;
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  const response = await handler(
    new NextRequest(init.url, { method: init.method, headers, body }),
    { params: Promise.resolve((init.params ?? {}) as P) },
  );
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** The user fields a denied request must leave alone. */
export async function snapshotUser(id: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      email: true,
      name: true,
      preferredName: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      status: true,
      twoFactorEnabled: true,
      deletedAt: true,
      deactivatedAt: true,
    },
  });
  return {
    ...user,
    positions: await prisma.userPosition.count({ where: { userId: id } }),
    sessions: await prisma.session.count({ where: { userId: id } }),
    twoFactorRows: await prisma.twoFactor.count({ where: { userId: id } }),
  };
}

/**
 * The audit rows written since the last call, for rows where one of `ids` is
 * the actor or the target. The users of a rolled-back case are new, so these
 * are that case's rows only. `ids` is read on every call, so a transfer id can
 * be added once it exists.
 */
export function auditTracker(ids: () => string[]) {
  const seen = new Set<string>();
  return {
    async fresh(): Promise<AuditEvent[]> {
      const list = ids();
      const rows = await prisma.auditEvent.findMany({
        where: {
          OR: [{ actorUserId: { in: list } }, { targetId: { in: list } }],
        },
        orderBy: { createdAt: "asc" },
      });
      const fresh = rows.filter((row) => !seen.has(row.id));
      for (const row of fresh) seen.add(row.id);
      return fresh;
    },
  };
}

const FORBIDDEN_KEYS = new Set([
  "password",
  "token",
  "secret",
  "backupCodes",
  "tokenHash",
  "cancelTokenHash",
  "accounts",
]);

/** Fails when a response body carries a credential-shaped key at any depth. */
export function expectNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoSecrets);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      expect(FORBIDDEN_KEYS.has(key), `response key ${key}`).toBe(false);
      expectNoSecrets(inner);
    }
  }
}

/** The `code` of an error body, or undefined. */
export function codeOf(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body) {
    return String((body as { code: unknown }).code);
  }
  return undefined;
}
