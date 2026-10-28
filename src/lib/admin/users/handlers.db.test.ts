import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  // The transaction client the shared `prisma` is routed to while a Primary
  // Admin test runs; `undefined` the rest of the time.
  scope: { current: undefined as unknown },
}));

// A Primary Admin can never be removed once committed, and the Primary Admin
// tests read and write it through the guard, the handlers and the fresh-auth
// check, all of which use the shared client. So while such a test runs, that
// client is routed to one transaction (and `$transaction` joins it), and the
// transaction is rolled back at the end: no Primary Admin is ever committed.
vi.mock("@/lib/prisma", async (importOriginal) => {
  const { prisma: real } =
    await importOriginal<typeof import("@/lib/prisma")>();
  const routed = new Proxy(real, {
    get(_target, key) {
      const active = mocks.scope.current as object | undefined;
      if (active && key === "$transaction") {
        return (fn: (tx: unknown) => unknown) => fn(active);
      }
      const source = active ?? real;
      const value = Reflect.get(source, key) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(source)
        : value;
    },
  });
  return { prisma: routed };
});

// The guard is the real one: only its session source and the limiter are
// replaced, as in the positions suites.
vi.mock("@/lib/auth/server", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: async () => null,
}));

import type { SendResult } from "@/lib/email/mailer";
import { createAdminUserHandlers } from "@/lib/admin/users/handlers";
import { clearAccountLock } from "@/lib/auth/lockout";
import { createFreshAuthGuard } from "@/lib/auth/fresh-auth";
import { buildAuthOptions } from "@/lib/auth/options";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { createSetPasswordService } from "@/lib/set-password/service";
import {
  buildSessionEndpointDeps,
  createSessionEndpoint,
} from "@/lib/sgauth-session/handler";
import { createCapturingMailer } from "@/test/capturing-mailer";
import {
  createAdmin,
  createPosition,
  createPrimaryAdmin,
  createSession,
  createUser,
} from "@/test/factories";
import { testLockout } from "@/test/lockout-options";

const BASE_URL = "http://localhost:3000";
const API = `${BASE_URL}/api/sgauth/admin/users`;
const IP = "203.0.113.7";
const PASSWORD = "correct-horse-battery-staple";
const MINUTE_MS = 60 * 1000;

const captured = createCapturingMailer();
const mailerState: { result: SendResult } = { result: { status: "sent" } };

const setPassword = createSetPasswordService({
  prisma,
  mailer: captured,
  limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  linkOrigin: BASE_URL,
  log: { info: () => undefined },
  now: () => new Date(),
});

// The real fresh-auth guard over the real `Session.lastReauthAt`; only the
// session lookup is stubbed, to the actor's current session row.
let currentSessionId = "";
const freshGuard = createFreshAuthGuard({
  getSession: async () => ({ session: { id: currentSessionId } }),
  prisma,
});

const handlers = createAdminUserHandlers({
  prisma,
  requireFreshAuth: async (headers) => {
    const result = await freshGuard(headers);
    return result.ok ? null : result.response;
  },
  clearAccountLock,
  issueAdminInvite: (db, input) => setPassword.issueAdminInvite(db, input),
  mailer: {
    sendEmail: async (message) => {
      await captured.sendEmail(message);
      return mailerState.result;
    },
  },
  now: () => new Date(),
});

function request(method: string, path: string, body?: unknown) {
  return new Request(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE_URL,
      "x-real-ip": IP,
      "user-agent": "vitest",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (params: Record<string, string>) => ({
  params: Promise.resolve(params),
});

const list = (query = "") => handlers.list(request("GET", query), ctx({}));
const create = (body: unknown) =>
  handlers.create(request("POST", "", body), ctx({}));
const get = (id: string) => handlers.get(request("GET", `/${id}`), ctx({ id }));
const patch = (id: string, body: unknown) =>
  handlers.update(request("PATCH", `/${id}`, body), ctx({ id }));
const remove = (id: string) =>
  handlers.remove(request("DELETE", `/${id}`), ctx({ id }));
const act = (id: string, action: string) =>
  handlers.action(request("POST", `/${id}/${action}`), ctx({ id, action }));

type Actor = { id: string };

/** Signs `actor` in with a session whose last re-authentication is fresh or stale. */
async function signInAs(actor: Actor, { fresh = true } = {}) {
  const session = await createSession(actor, {
    lastReauthAt: new Date(Date.now() - (fresh ? 0 : 11 * MINUTE_MS)),
  });
  currentSessionId = session.id;
  mocks.getSession.mockResolvedValue({ user: { id: actor.id } });
}

const auditIds = async (targetId: string) =>
  new Set(
    (await prisma.auditEvent.findMany({ where: { targetId } })).map(
      (row) => row.id,
    ),
  );

/** Runs `fn` and returns its response with the audit rows it wrote for the target. */
async function withAudit(targetId: string, fn: () => Promise<Response>) {
  const before = await auditIds(targetId);
  const response = await fn();
  const rows = (
    await prisma.auditEvent.findMany({ where: { targetId } })
  ).filter((row) => !before.has(row.id));
  return { response, rows };
}

/** The response fields the assertions read; anything else stays `unknown`. */
interface ApiBody {
  code?: string;
  email?: string;
  revokedSessions?: number;
  users: { id: string }[];
  issues: { path: string }[];
  user: { id: string; isAdmin: boolean; deactivatedAt: string | null };
  [key: string]: unknown;
}

const json = async (response: Response) => (await response.json()) as ApiBody;

const FORBIDDEN_KEYS = new Set([
  "password",
  "token",
  "secret",
  "backupCodes",
  "tokenHash",
  "accounts",
]);

function expectNoSecrets(value: unknown) {
  if (Array.isArray(value)) value.forEach(expectNoSecrets);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      expect(FORBIDDEN_KEYS.has(key), `key ${key}`).toBe(false);
      expectNoSecrets(inner);
    }
  }
}

let admin: Awaited<ReturnType<typeof createAdmin>>;

class Rollback extends Error {}

/**
 * Runs `body` with a Primary Admin that exists only inside a transaction that is
 * rolled back afterwards, so the test branch is left without one for the suites
 * that assert it has none. The Primary Admin has MFA enrolled.
 */
async function withPrimaryAdmin(
  body: (
    primary: Awaited<ReturnType<typeof createPrimaryAdmin>>,
  ) => Promise<void>,
) {
  await prisma
    .$transaction(
      async (tx) => {
        mocks.scope.current = tx;
        try {
          await body(await createPrimaryAdmin({ twoFactorEnabled: true }, tx));
        } finally {
          mocks.scope.current = undefined;
        }
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 30_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

beforeEach(async () => {
  mocks.getSession.mockReset();
  mailerState.result = { status: "sent" };
  captured.clear();
  admin = await createAdmin({ twoFactorEnabled: true });
  await signInAs(admin);
});

describe("the shared guard", () => {
  it("answers a non-admin NOT_ADMIN on a read and a mutation, and changes nothing", async () => {
    const outsider = await createUser();
    const target = await createUser();
    await signInAs(outsider);

    const read = await list();
    expect(read.status).toBe(403);
    expect(await json(read)).toMatchObject({ code: "NOT_ADMIN" });

    const { response, rows } = await withAudit(target.id, () =>
      act(target.id, "reactivate"),
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "NOT_ADMIN" });
    expect(rows).toHaveLength(0);
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const read = await list();
    expect(read.status).toBe(401);
    expect(await json(read)).toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await act("x", "unlock")).status).toBe(401);
  });

  it("answers MFA_REQUIRED to an admin who has not enrolled, on every kind of route", async () => {
    const unenrolled = await createAdmin({ twoFactorEnabled: false });
    const target = await createUser();
    await signInAs(unenrolled);

    const responses = [
      await list(),
      await get(target.id),
      await create({ email: "nobody@example.com", name: "Nobody" }),
      await act(target.id, "revoke-sessions"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await json(response)).toMatchObject({
        code: "MFA_REQUIRED",
        enrollmentUrl: "/account/security",
      });
    }
    expect(
      await prisma.user.count({ where: { email: "nobody@example.com" } }),
    ).toBe(0);
    expect(await auditIds(target.id)).toEqual(new Set());
  });

  it("answers ACTOR_INACTIVE to a deactivated admin whose session is still live", async () => {
    const target = await createUser();
    await prisma.user.update({
      where: { id: admin.id },
      data: { status: "DEACTIVATED" },
    });
    expect((await json(await list())).code).toBe("ACTOR_INACTIVE");
    const { response, rows } = await withAudit(target.id, () =>
      act(target.id, "revoke-sessions"),
    );
    expect(await json(response)).toMatchObject({ code: "ACTOR_INACTIVE" });
    expect(rows).toHaveLength(0);
  });
});

describe("GET /", () => {
  const marker = Math.random().toString(36).slice(2, 10);

  async function bulk(count: number) {
    const created = [];
    for (let i = 0; i < count; i += 1) {
      created.push(
        await createUser({
          name: `Bulk ${marker} ${String(i).padStart(2, "0")}`,
        }),
      );
    }
    return created;
  }

  it("pages newest first with a correct total", async () => {
    const created = await bulk(30);
    const newestFirst = created.map((user) => user.id).reverse();

    const second = await json(await list(`?q=${marker}&page=2&pageSize=10`));
    expect(second).toMatchObject({ page: 2, pageSize: 10, total: 30 });
    expect(second.users.map((u: { id: string }) => u.id)).toEqual(
      newestFirst.slice(10, 20),
    );

    const last = await json(await list(`?q=${marker}&page=4&pageSize=10`));
    expect(last.users).toEqual([]);
    expectNoSecrets(second);
  });

  it("defaults to 25 a page and rejects bad queries with issues", async () => {
    await bulk(1);
    expect(await json(await list())).toMatchObject({ page: 1, pageSize: 25 });
    const bad = await list("?pageSize=101&sort=name");
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({
      code: "INVALID_INPUT",
      issues: expect.any(Array),
    });
  });

  it("matches q against email, name and preferredName, ignoring case", async () => {
    const byName = await createUser({ name: `Zed ${marker}-name` });
    const byPreferred = await createUser({
      preferredName: `Pref ${marker}-pref`,
    });
    const byEmail = await createUser({
      email: `Mail-${marker}-mail@example.com`,
    });

    const ids = async (q: string) =>
      (await json(await list(`?q=${encodeURIComponent(q)}`))).users.map(
        (u: { id: string }) => u.id,
      );
    expect(await ids(`${marker}-NAME`)).toEqual([byName.id]);
    expect(await ids(`${marker}-PREF`)).toEqual([byPreferred.id]);
    expect(await ids(`MAIL-${marker}-MAIL`)).toEqual([byEmail.id]);
  });

  it("filters by position, status and admin flag, and hides tombstones by default", async () => {
    const holder = await createUser({ name: `Holder ${marker}` });
    const other = await createUser({ name: `Other ${marker}` });
    const active = await createPosition();
    const retired = await createPosition({ deletedAt: new Date() });
    await prisma.userPosition.createMany({
      data: [
        { userId: holder.id, positionId: active.id },
        { userId: other.id, positionId: retired.id },
      ],
    });
    const deactivated = await createUser({
      name: `Off ${marker}`,
      status: "DEACTIVATED",
    });
    const gone = await createUser({
      name: `Gone ${marker}`,
      status: "DELETED",
    });
    const boss = await createAdmin({ name: `Boss ${marker}` });

    const ids = async (query: string) =>
      (await json(await list(query))).users.map((u: { id: string }) => u.id);

    expect(await ids(`?position=${active.key}`)).toEqual([holder.id]);
    expect(await ids(`?position=${retired.key}`)).toEqual([]);
    expect(await ids(`?q=${marker}&status=DEACTIVATED`)).toEqual([
      deactivated.id,
    ]);
    expect(await ids(`?q=${marker}&isAdmin=true`)).toEqual([boss.id]);
    expect(await ids(`?q=${marker}&status=DELETED`)).toEqual([gone.id]);
    expect(await ids(`?q=${marker}&pageSize=100`)).not.toContain(gone.id);
  });
});

describe("GET /:id", () => {
  it("returns the detail with sessions and lock state, and no secrets", async () => {
    const user = await createUser({
      password: PASSWORD,
      twoFactorEnabled: true,
    });
    await prisma.twoFactor.create({
      data: {
        userId: user.id,
        secret: "seeded-secret",
        backupCodes: "seeded-codes",
      },
    });
    await createSession(user);
    await createSession(user);
    await createSession(user, { expiresAt: new Date(Date.now() - 1000) });
    const lockedUntil = new Date(Date.now() + 10 * MINUTE_MS);
    await prisma.accountLock.create({
      data: { userId: user.id, lockedUntil, lockLevel: 1 },
    });
    const position = await createPosition({ key: "zz-pos", name: "ZZ" });
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });

    const response = await get(user.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body.user).toMatchObject({
      id: user.id,
      email: user.email,
      hasPassword: true,
      twoFactorEnabled: true,
      activeSessions: 2,
      lockedUntil: lockedUntil.toISOString(),
      positions: [{ key: "zz-pos", name: "ZZ" }],
    });
    expectNoSecrets(body);
    expect(JSON.stringify(body)).not.toContain("seeded-secret");
  });

  it("returns a tombstone, and 404 for an unknown or malformed id", async () => {
    const gone = await createUser({ status: "DELETED" });
    expect((await get(gone.id)).status).toBe(200);
    const unknown = await get("0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e");
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ code: "USER_NOT_FOUND" });
    expect((await get("nope")).status).toBe(404);
  });
});

describe("POST /", () => {
  it("creates a password-less user, invites them and writes one USER_CREATED row", async () => {
    const email = `Invitee-${Math.random().toString(36).slice(2, 8)}@Example.com`;
    const response = await create({ email, name: "New Officer" });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toMatchObject({
      email: "sent",
      user: {
        email: email.toLowerCase(),
        name: "New Officer",
        status: "ACTIVE",
        hasPassword: false,
        emailVerified: true,
      },
    });

    const rows = await prisma.auditEvent.findMany({
      where: { targetId: body.user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "USER_CREATED",
      actorType: "USER",
      actorUserId: admin.id,
      metadata: { source: "admin", invited: true },
    });

    const [message] = captured.to(email);
    expect(captured.sent).toHaveLength(1);
    expect(message).toMatchObject({
      template: "set-password",
      data: { kind: "admin-invite", name: "New Officer" },
    });
    expect(String(message.data.url).startsWith(`${BASE_URL}/`)).toBe(true);
    expect(
      await prisma.account.count({ where: { userId: body.user.id } }),
    ).toBe(0);
  });

  it("skips the email and says so when sendInvite is false", async () => {
    const email = `quiet-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const response = await create({ email, name: "Quiet", sendInvite: false });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.email).toBe("skipped");
    expect(captured.sent).toHaveLength(0);
    const [row] = await prisma.auditEvent.findMany({
      where: { targetId: body.user.id },
    });
    expect(row.metadata).toEqual({ source: "admin", invited: false });
  });

  it("answers EMAIL_TAKEN for an existing address in any case, and writes nothing", async () => {
    const existing = await createUser();
    const before = await auditIds(existing.id);
    const response = await create({
      email: existing.email.toUpperCase(),
      name: "Copy",
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "EMAIL_TAKEN" });
    expect(await auditIds(existing.id)).toEqual(before);
    expect(captured.sent).toHaveLength(0);
  });

  it("answers 400 with issue paths and no input values for a bad body", async () => {
    const response = await create({ email: "secret-value", name: "" });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      "email",
      "name",
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });

  it("still answers 201 when the mailer is capped", async () => {
    mailerState.result = { status: "capped", cap: "recipient:1h" };
    const response = await create({
      email: `capped-${Math.random().toString(36).slice(2, 8)}@example.com`,
      name: "Capped",
    });
    expect(response.status).toBe(201);
    expect((await json(response)).email).toBe("capped");
  });
});

describe("PATCH /:id", () => {
  it("updates the changed fields and records only their names", async () => {
    const user = await createUser({ preferredName: "Old" });
    const { response, rows } = await withAudit(user.id, () =>
      patch(user.id, { name: "Fresh Name", preferredName: null }),
    );
    expect(response.status).toBe(200);
    expect((await json(response)).user).toMatchObject({
      name: "Fresh Name",
      preferredName: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "USER_UPDATED",
      actorUserId: admin.id,
      metadata: { fields: ["name", "preferredName"] },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Fresh Name");
  });

  it("writes nothing and no audit row when nothing changed", async () => {
    const user = await createUser({ preferredName: "Same" });
    const { response, rows } = await withAudit(user.id, () =>
      patch(user.id, { name: user.name, preferredName: "Same" }),
    );
    expect(response.status).toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("answers 400 for a body that is not JSON, with no issues", async () => {
    const user = await createUser();
    const response = await handlers.update(
      new Request(`${API}/${user.id}`, { method: "PATCH", body: "not json" }),
      ctx({ id: user.id }),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: "INVALID_INPUT",
      issues: [],
    });
  });

  it("allows an admin to edit the Primary Admin's profile and their own", async () => {
    const own = await patch(admin.id, { preferredName: "Me" });
    expect(own.status).toBe(200);
    await withPrimaryAdmin(async (primary) => {
      const other = await patch(primary.id, { preferredName: "PA nickname" });
      expect(other.status).toBe(200);
    });
  });
});

describe("the eight actions", () => {
  it("deactivate: revokes every session, writes one row and answers the count", async () => {
    const user = await createUser();
    await Promise.all([createSession(user), createSession(user)]);
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "deactivate"),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      revokedSessions: 2,
      user: { status: "DEACTIVATED" },
    });
    expect(body.user.deactivatedAt).toEqual(expect.any(String));
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "USER_DEACTIVATED",
      actorUserId: admin.id,
      targetType: "USER",
      metadata: { revokedSessions: 2 },
      ip: IP,
    });
  });

  it("reactivate: restores ACTIVE and clears deactivatedAt, even on a stale session", async () => {
    await signInAs(admin, { fresh: false });
    const user = await createUser({
      status: "DEACTIVATED",
      deactivatedAt: new Date(),
    });
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "reactivate"),
    );
    expect(response.status).toBe(200);
    expect((await json(response)).user).toMatchObject({
      status: "ACTIVE",
      deactivatedAt: null,
    });
    expect(rows.map((r) => r.type)).toEqual(["USER_REACTIVATED"]);
  });

  it("grant-admin and revoke-admin: flip the flag, notify on a grant", async () => {
    const user = await createUser();
    const granted = await withAudit(user.id, () => act(user.id, "grant-admin"));
    expect(granted.response.status).toBe(200);
    expect(await json(granted.response)).toMatchObject({
      email: "sent",
      user: { isAdmin: true },
    });
    expect(granted.rows.map((r) => r.type)).toEqual(["ADMIN_GRANTED"]);
    expect(captured.to(user.email)).toEqual([
      expect.objectContaining({
        template: "security-notice",
        data: expect.objectContaining({ event: "admin-granted" }),
      }),
    ]);

    captured.clear();
    const revoked = await withAudit(user.id, () =>
      act(user.id, "revoke-admin"),
    );
    expect((await json(revoked.response)).user.isAdmin).toBe(false);
    expect(revoked.rows.map((r) => r.type)).toEqual(["ADMIN_REVOKED"]);
    expect(captured.sent).toHaveLength(0);
  });

  it("revoke-sessions: deletes every session and says how many", async () => {
    const user = await createUser();
    await Promise.all([
      createSession(user),
      createSession(user),
      createSession(user),
    ]);
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "revoke-sessions"),
    );
    expect(await json(response)).toMatchObject({ revokedSessions: 3 });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "SESSIONS_REVOKED",
      metadata: { scope: "all" },
    });
  });

  it("unlock: lifts a live lock and records the admin method", async () => {
    const user = await createUser();
    await prisma.accountLock.create({
      data: {
        userId: user.id,
        lockedUntil: new Date(Date.now() + 30 * MINUTE_MS),
        lockLevel: 1,
      },
    });
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "unlock"),
    );
    expect(response.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "ACCOUNT_UNLOCKED",
      metadata: { method: "admin" },
    });
    const lock = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(lock.lockedUntil === null || lock.lockedUntil < new Date()).toBe(
      true,
    );
  });

  it("reset-mfa: removes the factor, clears the flag and emails the user", async () => {
    const user = await createUser({ twoFactorEnabled: true });
    await prisma.twoFactor.create({
      data: { userId: user.id, secret: "s", backupCodes: "b" },
    });
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "reset-mfa"),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      email: "sent",
      user: { twoFactorEnabled: false },
    });
    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(rows.map((r) => r.type)).toEqual(["MFA_RESET"]);
    expect(captured.to(user.email)[0]).toMatchObject({
      template: "security-notice",
      data: { event: "mfa-reset" },
    });
  });

  it("resend-invite: issues a new link, writes USER_INVITED and emails it", async () => {
    const user = await createUser();
    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "resend-invite"),
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ email: "sent" });
    expect(rows.map((r) => r.type)).toEqual(["USER_INVITED"]);
    expect(captured.to(user.email)[0]).toMatchObject({
      template: "set-password",
      data: { kind: "admin-invite" },
    });
  });

  it("reports a capped email without failing the action", async () => {
    mailerState.result = { status: "capped", cap: "recipient:1h" };
    const user = await createUser();
    const response = await act(user.id, "grant-admin");
    expect(response.status).toBe(200);
    expect((await json(response)).email).toBe("capped");
  });
});

describe("denials", () => {
  const SELF = [
    "deactivate",
    "reactivate",
    "grant-admin",
    "revoke-admin",
  ] as const;

  it.each(SELF)(
    "refuses %s on yourself with SELF_MODIFICATION",
    async (action) => {
      const { response, rows } = await withAudit(admin.id, () =>
        act(admin.id, action),
      );
      expect(response.status).toBe(403);
      expect(await json(response)).toMatchObject({ code: "SELF_MODIFICATION" });
      expect(rows).toHaveLength(0);
    },
  );

  it("refuses delete on yourself, and reset-mfa by a non-Primary Admin on an admin", async () => {
    const del = await remove(admin.id);
    expect(await json(del)).toMatchObject({ code: "SELF_MODIFICATION" });
    const reset = await act(admin.id, "reset-mfa");
    expect(await json(reset)).toMatchObject({ code: "PRIMARY_ADMIN_REQUIRED" });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }),
    ).toMatchObject({ status: "ACTIVE", isAdmin: true });
  });

  it.each(["deactivate", "revoke-admin", "reset-mfa"])(
    "refuses %s on the Primary Admin with PRIMARY_ADMIN_PROTECTED",
    async (action) => {
      await withPrimaryAdmin(async (primary) => {
        const { response, rows } = await withAudit(primary.id, () =>
          act(primary.id, action),
        );
        expect(response.status).toBe(403);
        expect(await json(response)).toMatchObject({
          code: "PRIMARY_ADMIN_PROTECTED",
        });
        expect(rows).toHaveLength(0);
      });
    },
  );

  it("refuses to delete the Primary Admin", async () => {
    await withPrimaryAdmin(async (primary) => {
      const response = await remove(primary.id);
      expect(response.status).toBe(403);
      expect(await json(response)).toMatchObject({
        code: "PRIMARY_ADMIN_PROTECTED",
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: primary.id } }))
          .status,
      ).toBe("ACTIVE");
    });
  });

  it("lets sessions be revoked and an account unlocked on the Primary Admin", async () => {
    await withPrimaryAdmin(async (primary) => {
      await prisma.accountLock.upsert({
        where: { userId: primary.id },
        create: {
          userId: primary.id,
          lockedUntil: new Date(Date.now() + 30 * MINUTE_MS),
          lockLevel: 1,
        },
        update: { lockedUntil: new Date(Date.now() + 30 * MINUTE_MS) },
      });
      expect((await act(primary.id, "revoke-sessions")).status).toBe(200);
      expect((await act(primary.id, "unlock")).status).toBe(200);
    });
  });

  it("lets the Primary Admin reset the MFA of another admin", async () => {
    const other = await createAdmin({ twoFactorEnabled: true });
    await withPrimaryAdmin(async (primary) => {
      await signInAs(primary);
      const { response, rows } = await withAudit(other.id, () =>
        act(other.id, "reset-mfa"),
      );
      expect(response.status).toBe(200);
      expect(rows.map((r) => r.type)).toEqual(["MFA_RESET"]);
    });
  });

  it.each(["deactivate", "grant-admin", "revoke-admin", "reset-mfa"])(
    "asks for re-authentication before %s on a stale session",
    async (action) => {
      await signInAs(admin, { fresh: false });
      const user = await createUser({ isAdmin: action === "revoke-admin" });
      const { response, rows } = await withAudit(user.id, () =>
        act(user.id, action),
      );
      expect(response.status).toBe(403);
      expect(await json(response)).toMatchObject({ code: "REAUTH_REQUIRED" });
      expect(rows).toHaveLength(0);
    },
  );

  it("asks for re-authentication before delete on a stale session", async () => {
    await signInAs(admin, { fresh: false });
    const user = await createUser();
    const response = await remove(user.id);
    expect(await json(response)).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status,
    ).toBe("ACTIVE");
  });

  it("runs can() before the re-auth check", async () => {
    await signInAs(admin, { fresh: false });
    const response = await act(admin.id, "deactivate");
    expect(await json(response)).toMatchObject({ code: "SELF_MODIFICATION" });
  });
});

describe("conflicts and bad input", () => {
  it("answers 409 for a repeat or a state that does not apply", async () => {
    const user = await createUser({ password: PASSWORD });
    const admin2 = await createAdmin({ twoFactorEnabled: true });

    expect((await act(user.id, "deactivate")).status).toBe(200);
    expect(await json(await act(user.id, "deactivate"))).toMatchObject({
      code: "ALREADY_DEACTIVATED",
    });
    expect(await json(await act(user.id, "resend-invite"))).toMatchObject({
      code: "USER_DEACTIVATED",
    });
    expect((await act(user.id, "reactivate")).status).toBe(200);
    expect(await json(await act(user.id, "reactivate"))).toMatchObject({
      code: "NOT_DEACTIVATED",
    });
    expect(await json(await act(admin2.id, "grant-admin"))).toMatchObject({
      code: "ALREADY_ADMIN",
    });
    expect(await json(await act(user.id, "revoke-admin"))).toMatchObject({
      code: "NOT_AN_ADMIN",
    });
    expect(await json(await act(user.id, "unlock"))).toMatchObject({
      code: "NOT_LOCKED",
    });
    expect(await json(await act(user.id, "reset-mfa"))).toMatchObject({
      code: "MFA_NOT_ENROLLED",
    });
    expect(await json(await act(user.id, "resend-invite"))).toMatchObject({
      code: "PASSWORD_ALREADY_SET",
    });
  });

  it("answers USER_DELETED for every mutation on a tombstone", async () => {
    const gone = await createUser({ status: "DELETED" });
    for (const action of [
      "deactivate",
      "reactivate",
      "grant-admin",
      "revoke-admin",
      "revoke-sessions",
      "unlock",
      "reset-mfa",
      "resend-invite",
    ]) {
      const response = await act(gone.id, action);
      expect(response.status, action).toBe(409);
      expect(await json(response)).toMatchObject({ code: "USER_DELETED" });
    }
    expect((await patch(gone.id, { name: "Back" })).status).toBe(409);
    expect((await remove(gone.id)).status).toBe(409);
  });

  it("answers 404 for a malformed or unknown id and for an unknown action", async () => {
    const user = await createUser();
    for (const response of [
      await act("not-a-uuid", "unlock"),
      await act("0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e", "unlock"),
      await patch("not-a-uuid", { name: "x" }),
      await remove("not-a-uuid"),
    ]) {
      expect(response.status).toBe(404);
      expect(await json(response)).toMatchObject({ code: "USER_NOT_FOUND" });
    }
    for (const action of ["frobnicate", "Deactivate", "delete"]) {
      const response = await act(user.id, action);
      expect(response.status).toBe(404);
      expect(await json(response)).toMatchObject({ code: "UNKNOWN_ACTION" });
    }
  });

  it("does not reveal which actions exist to someone who is not an admin", async () => {
    const outsider = await createUser();
    await signInAs(outsider);
    const response = await act(outsider.id, "frobnicate");
    expect(await json(response)).toMatchObject({ code: "NOT_ADMIN" });
  });

  it("lets only one of two simultaneous deactivations through", async () => {
    const user = await createUser();
    await createSession(user);
    const before = await auditIds(user.id);
    const responses = await Promise.all([
      act(user.id, "deactivate"),
      act(user.id, "deactivate"),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = (
      await prisma.auditEvent.findMany({ where: { targetId: user.id } })
    ).filter((row) => !before.has(row.id));
    expect(rows).toHaveLength(1);
  });
});

describe("DELETE /:id (the tombstone)", () => {
  it("scrubs the user, removes what hangs off them and writes one USER_DELETED row", async () => {
    const user = await createUser({
      password: PASSWORD,
      preferredName: "Sam",
      twoFactorEnabled: true,
      isAdmin: true,
    });
    await createSession(user);
    await prisma.twoFactor.create({
      data: { userId: user.id, secret: "s", backupCodes: "b" },
    });
    const position = await createPosition();
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });

    const { response, rows } = await withAudit(user.id, () => remove(user.id));
    expect(response.status).toBe(200);
    expect((await json(response)).user).toMatchObject({
      id: user.id,
      status: "DELETED",
      email: `deleted+${user.id}@invalid`,
      name: "Deleted user",
      preferredName: null,
      isAdmin: false,
      twoFactorEnabled: false,
      hasPassword: false,
      positions: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "USER_DELETED",
      actorUserId: admin.id,
      metadata: { reason: "admin", removedPositionIds: [position.id] },
      ip: null,
      userAgent: null,
    });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("deactivation and the product session endpoint (AC 2)", () => {
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: "s".repeat(32),
      lockout: testLockout(),
    }),
  );
  const endpoint = createSessionEndpoint(
    buildSessionEndpointDeps({
      auth,
      prisma,
      limiter: createRateLimiter({
        backend: createMemoryBackend(),
        log: { error: () => undefined },
      }),
      log: { warn: () => undefined },
    }),
  );

  async function signIn(email: string): Promise<string> {
    const result = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    return result.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }

  const product = (cookie: string) =>
    endpoint.full(
      new Request(`${BASE_URL}/api/sgauth/session`, { headers: { cookie } }),
    );

  it("leaves no session and answers 401 to each of three cookies, then refuses a new sign-in", async () => {
    const user = await createUser({ password: PASSWORD });
    const cookies = [
      await signIn(user.email),
      await signIn(user.email),
      await signIn(user.email),
    ];
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(3);
    for (const cookie of cookies)
      expect((await product(cookie)).status).toBe(200);

    const { response, rows } = await withAudit(user.id, () =>
      act(user.id, "deactivate"),
    );
    expect(await json(response)).toMatchObject({ revokedSessions: 3 });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "USER_DEACTIVATED",
      metadata: { revokedSessions: 3 },
    });
    for (const cookie of cookies)
      expect((await product(cookie)).status).toBe(401);

    const refused = await signIn(user.email).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      statusCode: 403,
      body: { code: "ACCOUNT_DEACTIVATED" },
    });
  });

  it("answers 401 for a user deactivated directly in SQL with a live session", async () => {
    const user = await createUser({ password: PASSWORD });
    const cookie = await signIn(user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });
    expect((await product(cookie)).status).toBe(401);
  });
});
