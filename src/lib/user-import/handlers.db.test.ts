import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

// The guard is the real one: only its session source and the limiter are
// replaced, as in the admin user suites.
vi.mock("@/lib/auth/server", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: async () => null,
}));

import { createFreshAuthGuard } from "@/lib/auth/fresh-auth";
import { prisma } from "@/lib/prisma";
import { createUserImportHandlers } from "@/lib/user-import/handlers";
import type { InviteAttempt } from "@/lib/user-import/invites";
import {
  createAdmin,
  createPosition,
  createSession,
  createUser,
} from "@/test/factories";

const BASE_URL = "http://localhost:3000";
const MINUTE_MS = 60 * 1000;
const tag = Math.random().toString(36).slice(2, 8);
let counter = 0;
const address = () => `route-${(counter += 1)}-${tag}@northeastern.edu`;

let currentSessionId = "";
const freshGuard = createFreshAuthGuard({
  getSession: async () => ({ session: { id: currentSessionId } }),
  prisma,
});

const invited: string[] = [];
const inviteResult: { next: (userId: string) => InviteAttempt } = {
  next: () => ({ status: "sent" }),
};

const handlers = createUserImportHandlers({
  prisma,
  requireFreshAuth: async (headers) => {
    const result = await freshGuard(headers);
    return result.ok ? null : result.response;
  },
  sendInvite: async (userId) => {
    invited.push(userId);
    return inviteResult.next(userId);
  },
  sleep: async () => undefined,
});

const post = (path: string, body: unknown) =>
  new Request(`${BASE_URL}/api/sgauth/admin/users/import${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE_URL,
      "x-real-ip": "203.0.113.7",
      "user-agent": "vitest",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const preview = (csv: string) => handlers.preview(post("/preview", { csv }));
const apply = (body: unknown) => handlers.apply(post("", body));

interface Body {
  code?: string;
  digest?: string;
  summary?: Record<string, number>;
  rows?: { line: number; result?: string; invite?: string }[];
  invites?: Record<string, number> | null;
  preview?: { digest: string };
  issues?: { code: string }[];
}
const json = async (response: Response) => (await response.json()) as Body;

async function signInAs(actor: { id: string }, { fresh = true } = {}) {
  const session = await createSession(actor, {
    lastReauthAt: new Date(Date.now() - (fresh ? 0 : 11 * MINUTE_MS)),
  });
  currentSessionId = session.id;
  mocks.getSession.mockResolvedValue({ user: { id: actor.id } });
}

let admin: Awaited<ReturnType<typeof createAdmin>>;

beforeEach(async () => {
  mocks.getSession.mockReset();
  invited.length = 0;
  inviteResult.next = () => ({ status: "sent" });
  admin = await createAdmin({ twoFactorEnabled: true });
  await signInAs(admin);
});

const file = (...lines: string[]) =>
  ["email,name,positions", ...lines].join("\r\n") + "\r\n";

const imported = () =>
  prisma.user.count({ where: { email: { contains: tag } } });

const auditRows = (type: string) =>
  prisma.auditEvent.findMany({
    where: { type, actorUserId: admin.id },
    orderBy: { createdAt: "asc" },
  });

describe("the guard", () => {
  it("refuses a non-admin on both routes and writes nothing", async () => {
    await signInAs(await createUser());
    const csv = file(`${address()},Ann,`);
    const dry = await preview(csv);
    expect(dry.status).toBe(403);
    expect(await json(dry)).toMatchObject({ code: "NOT_ADMIN" });
    const wet = await apply({
      csv,
      digest: "0".repeat(64),
      skipInvalid: false,
      sendInvites: false,
    });
    expect(wet.status).toBe(403);
    expect(await json(wet)).toMatchObject({ code: "NOT_ADMIN" });
    expect(await imported()).toBe(0);
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await preview(file(`${address()},Ann,`))).status).toBe(401);
  });

  it("answers MFA_REQUIRED to an admin who has not enrolled", async () => {
    await signInAs(await createAdmin({ twoFactorEnabled: false }));
    const response = await preview(file(`${address()},Ann,`));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "MFA_REQUIRED" });
  });
});

describe("POST /preview", () => {
  it("diffs the file and writes nothing", async () => {
    const position = await createPosition();
    const existing = await createUser();
    const response = await preview(
      file(
        `${address()},New One,${position.key}`,
        `${existing.email},Whoever,${position.key}`,
        "not-an-email,Bad,",
      ),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.summary).toMatchObject({
      rows: 3,
      create: 1,
      update: 1,
      invalid: 1,
      assignments: 2,
    });
    expect(await imported()).toBe(0);
    expect(await auditRows("BULK_IMPORT")).toHaveLength(0);
  });

  it.each([
    ["a body that is not JSON", "not json"],
    ["an unknown key", { csv: "a", extra: 1 }],
    ["an empty file", { csv: "" }],
  ])("answers 400 INVALID_INPUT for %s", async (_label, body) => {
    const response = await handlers.preview(post("/preview", body));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers 422 INVALID_FILE for a bad header", async () => {
    const response = await preview(
      "Email,Full name,positions\r\na@x.edu,A,\r\n",
    );
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      code: "INVALID_FILE",
      issues: [{ code: "BAD_HEADER" }],
    });
  });
});

describe("POST /", () => {
  async function digestOf(csv: string) {
    return (await json(await preview(csv))).digest as string;
  }
  const body = (csv: string, digest: string, over: object = {}) => ({
    csv,
    digest,
    skipInvalid: false,
    sendInvites: false,
    ...over,
  });

  it("asks for fresh re-authentication and writes nothing", async () => {
    await signInAs(admin, { fresh: false });
    const csv = file(`${address()},Ann,`);
    const response = await apply(body(csv, "0".repeat(64)));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(await imported()).toBe(0);
  });

  it("imports, audits every change and answers with per-row results", async () => {
    const [a, b] = await Promise.all([createPosition(), createPosition()]);
    const existing = await createUser();
    const csv = file(
      `${address()},One,${a.key}|${b.key}`,
      `${address()},Two,`,
      `${existing.email},Ignored,${a.key}`,
    );
    const response = await apply(body(csv, await digestOf(csv)));
    expect(response.status).toBe(200);
    const result = await json(response);
    expect(result.rows?.map((row) => row.result)).toEqual([
      "created",
      "created",
      "updated",
    ]);
    expect(result.invites).toBeNull();
    expect(await imported()).toBe(2);

    const created = await auditRows("USER_CREATED");
    expect(created).toHaveLength(2);
    expect(created[0]?.metadata).toEqual({ source: "bulk_import" });
    expect(await auditRows("POSITION_ASSIGNED")).toHaveLength(3);
    const [summary] = await auditRows("BULK_IMPORT");
    expect(summary).toMatchObject({
      targetType: null,
      targetId: null,
      ip: "203.0.113.7",
      metadata: {
        source: "csv",
        rows: 3,
        created: 2,
        updated: 1,
        unchanged: 0,
        skipped: 0,
        positionsAssigned: 3,
        skipInvalid: false,
        sendInvites: false,
      },
    });
    expect(invited).toEqual([]);
  });

  it("is idempotent, and still writes one BULK_IMPORT", async () => {
    const position = await createPosition();
    const csv = file(`${address()},One,${position.key}`);
    await apply(body(csv, await digestOf(csv)));
    const again = await apply(body(csv, await digestOf(csv)));
    expect(again.status).toBe(200);
    expect((await json(again)).rows?.[0]?.result).toBe("unchanged");
    expect(await auditRows("USER_CREATED")).toHaveLength(1);
    expect(await auditRows("POSITION_ASSIGNED")).toHaveLength(1);
    const summaries = await auditRows("BULK_IMPORT");
    expect(summaries).toHaveLength(2);
    expect(summaries[1]?.metadata).toMatchObject({ created: 0, unchanged: 1 });
  });

  it("refuses a changed plan with PLAN_CHANGED and writes nothing", async () => {
    const position = await createPosition();
    const csv = file(`${address()},One,${position.key}`);
    const digest = await digestOf(csv);
    await prisma.position.update({
      where: { id: position.id },
      data: { deletedAt: new Date() },
    });
    const response = await apply(body(csv, digest));
    expect(response.status).toBe(409);
    const result = await json(response);
    expect(result.code).toBe("PLAN_CHANGED");
    expect(result.preview?.digest).not.toBe(digest);
    expect(await imported()).toBe(0);
    expect(await auditRows("BULK_IMPORT")).toHaveLength(0);
  });

  it("refuses invalid rows unless skipped, then imports the rest", async () => {
    const csv = file(`${address()},One,`, "not-an-email,Bad,");
    const digest = await digestOf(csv);

    const refused = await apply(body(csv, digest));
    expect(refused.status).toBe(422);
    expect((await json(refused)).code).toBe("INVALID_ROWS");
    expect(await imported()).toBe(0);

    const skipped = await apply(body(csv, digest, { skipInvalid: true }));
    expect(skipped.status).toBe(200);
    expect((await json(skipped)).rows?.map((row) => row.result)).toEqual([
      "created",
      "skipped",
    ]);
    expect(await imported()).toBe(1);
    expect((await auditRows("BULK_IMPORT"))[0]?.metadata).toMatchObject({
      skipped: 1,
      skipInvalid: true,
    });
  });

  it("answers 422 INVALID_FILE for a malformed file", async () => {
    const response = await apply(
      body('email,name,positions\r\na@x.edu,"Ann,\r\n', "0".repeat(64)),
    );
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ code: "INVALID_FILE" });
  });

  it("answers 400 for a digest that is not a SHA-256", async () => {
    const response = await apply(body(file(`${address()},A,`), "nope"));
    expect(response.status).toBe(400);
  });

  it("sends invites only when asked, after the commit, and reports each", async () => {
    const csv = file(`${address()},One,`, `${address()},Two,`);
    // The second send trips the daily cap.
    inviteResult.next = () =>
      invited.length === 2
        ? { status: "capped", cap: "global:1d" }
        : { status: "sent" };

    const response = await apply(
      body(csv, await digestOf(csv), { sendInvites: true }),
    );
    expect(response.status).toBe(200);
    const result = await json(response);
    expect(invited).toHaveLength(2);
    expect(result.invites).toMatchObject({ sent: 1, deferredDailyCap: 1 });
    expect(result.rows?.map((row) => row.invite)).toEqual([
      "sent",
      "deferred_daily_cap",
    ]);
    expect(await imported()).toBe(2);
  });

  it("does not invite a user who has a password", async () => {
    const holder = await createUser({ password: "correct-horse-battery" });
    const csv = file(`${holder.email},Whoever,`);
    const response = await apply(
      body(csv, await digestOf(csv), { sendInvites: true }),
    );
    expect((await json(response)).invites).toMatchObject({
      sent: 0,
      skippedHasPassword: 1,
    });
    expect(invited).toEqual([]);
  });
});
