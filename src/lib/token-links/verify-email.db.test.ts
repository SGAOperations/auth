import { afterAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import { scannerResponse } from "@/lib/token-links/scanner";
import {
  createVerifyEmailConsumer,
  loadVerifyEmailView,
} from "@/lib/token-links/verify-email";
import { hashVerifyToken } from "@/lib/token-links/verify-email-token";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";

// AC1: a HEAD or GET to an emailed link does not consume the token, and the
// subsequent POST does, exactly once.
describe.skipIf(!url)("scanner-safe verify-email link", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The
  // options are the real ones, so the real hooks and disabledPaths apply.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: testLockout(),
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t103-${counter++}-${rand}@northeastern.edu`;
  const tokens: string[] = [];

  const log = { error: vi.fn() };
  const limit = async () => ({ allowed: true, retryAfterSeconds: 0 });

  function handlerFor(
    consumerAuth: Parameters<typeof createVerifyEmailConsumer>[0]["auth"],
  ) {
    return createTokenActionHandler({
      action: "verify-email",
      consume: createVerifyEmailConsumer({
        auth: consumerAuth,
        db: prisma,
        secret: SECRET,
        resolveRedirect: async () => "/account",
      }),
      limit,
      log,
    });
  }
  const handle = handlerFor(auth);

  // Audit rows cannot be deleted, so assertions filter by this run's users.
  afterAll(async () => {
    await prisma.usedEmailVerificationToken.deleteMany({
      where: { tokenHash: { in: tokens.map(hashVerifyToken) } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function signUpWithToken() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    tokens.push(token);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { email, token, user };
  }

  function post(
    token: string,
    headers: Record<string, string> = { origin: BASE_URL },
  ) {
    return new Request(`${BASE_URL}/verify-email/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ token }).toString(),
    });
  }

  // A successful verification redirects to the resolved target, /account here,
  // with no `result` parameter.
  const result = (response: Response) => {
    const location = new URL(response.headers.get("location") ?? "");
    return location.pathname === "/account"
      ? "done"
      : location.searchParams.get("result");
  };

  const reload = (id: string) =>
    prisma.user.findUniqueOrThrow({ where: { id } });

  const verifiedEvents = (id: string) =>
    prisma.auditEvent.count({
      where: {
        type: "EMAIL_VERIFIED",
        OR: [{ targetId: id }, { actorUserId: id }],
      },
    });

  const rowCount = (token: string) =>
    prisma.usedEmailVerificationToken.count({
      where: { tokenHash: hashVerifyToken(token) },
    });

  it("closes Better Auth's HTTP GET and HEAD verify endpoint", async () => {
    const { token, user } = await signUpWithToken();
    for (const method of ["GET", "HEAD"]) {
      const response = await auth.handler(
        new Request(`${BASE_URL}/api/auth/verify-email?token=${token}`, {
          method,
        }),
      );
      expect(response.status).toBe(404);
    }
    expect((await reload(user.id)).emailVerified).toBe(false);
    expect(await verifiedEvents(user.id)).toBe(0);
  });

  it("consumes nothing on HEAD, a scanner GET or the page's own GET", async () => {
    const { email, token, user } = await signUpWithToken();

    expect(scannerResponse("HEAD", "/verify-email", "Chrome")?.status).toBe(
      200,
    );
    expect(scannerResponse("GET", "/verify-email", "BingPreview")?.status).toBe(
      200,
    );
    expect(
      await loadVerifyEmailView({ token }, { secret: SECRET, db: prisma }),
    ).toEqual({ state: "ready", token, email });

    expect((await reload(user.id)).emailVerified).toBe(false);
    expect(await rowCount(token)).toBe(0);
    expect(await verifiedEvents(user.id)).toBe(0);
  });

  it("consumes on the POST exactly once", async () => {
    const { token, user } = await signUpWithToken();
    await prisma.session.create({
      data: {
        token: `t103-${rand}-session-${counter++}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const first = await handle(post(token));
    expect(first.status).toBe(303);
    expect(result(first)).toBe("done");
    expect((await reload(user.id)).emailVerified).toBe(true);
    // The inserted session is revoked; the auto-sign-in session is the one left.
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(first.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await verifiedEvents(user.id)).toBe(1);
    expect(await rowCount(token)).toBe(1);

    const second = await handle(post(token));
    expect(result(second)).toBe("used");
    expect(await verifiedEvents(user.id)).toBe(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await loadVerifyEmailView({ token }, { secret: SECRET, db: prisma }),
    ).toEqual({ state: "used" });
  });

  it("lets exactly one of two concurrent POSTs win", async () => {
    const { token, user } = await signUpWithToken();
    const responses = await Promise.all([
      handle(post(token)),
      handle(post(token)),
    ]);
    expect(responses.map(result).sort()).toEqual(["done", "used"]);
    expect(await verifiedEvents(user.id)).toBe(1);
  });

  it("makes a change-email token single use too", async () => {
    const { email, user } = await signUpWithToken();
    const next = `t103-${counter++}-${rand}-new@northeastern.edu`;
    const token = await createEmailVerificationToken(
      SECRET,
      email,
      next,
      undefined,
      { requestType: "change-email-verification" },
    );
    tokens.push(token);

    expect(result(await handle(post(token)))).toBe("done");
    const changed = await reload(user.id);
    expect(changed.email).toBe(next);
    expect(changed.emailVerified).toBe(true);

    expect(result(await handle(post(token)))).toBe("used");
    expect((await reload(user.id)).email).toBe(next);
    expect(await verifiedEvents(user.id)).toBe(1);
  });

  it("releases the claim when verification throws, so the link retries", async () => {
    const { token, user } = await signUpWithToken();
    const failing = handlerFor({
      api: {
        verifyEmail: vi.fn().mockRejectedValueOnce(new Error("boom")),
      },
    });

    expect(result(await failing(post(token)))).toBe("error");
    expect(log.error).toHaveBeenCalledWith("token_link_failed", {
      action: "verify-email",
      errorName: "Error",
    });
    expect(await rowCount(token)).toBe(0);
    expect((await reload(user.id)).emailVerified).toBe(false);

    expect(result(await handle(post(token)))).toBe("done");
    expect((await reload(user.id)).emailVerified).toBe(true);
  });

  it("rejects a cross-origin POST without a claim", async () => {
    const { token, user } = await signUpWithToken();
    const response = await handle(
      post(token, { origin: "https://evil.example.com" }),
    );
    expect(response.status).toBe(403);
    expect((await reload(user.id)).emailVerified).toBe(false);
    expect(await rowCount(token)).toBe(0);
  });

  it("answers a tampered token invalid and writes nothing", async () => {
    const { token, user } = await signUpWithToken();
    const tampered = `${token.slice(0, -2)}xx`;
    tokens.push(tampered);

    expect(result(await handle(post(tampered)))).toBe("invalid");
    expect((await reload(user.id)).emailVerified).toBe(false);
    expect(await rowCount(tampered)).toBe(0);
  });
});
