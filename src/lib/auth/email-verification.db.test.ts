import { afterAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { decodeJwt } from "jose";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { createAuthRouteLimiter } from "@/lib/rate-limit/auth-route";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { testLockout } from "@/test/lockout-options";
import { createResendVerifyEmailConsumer } from "@/lib/token-links/verify-email";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";

describe.skipIf(!url)("email verification on sign-up", () => {
  // Own client and auth instance with the real options, as in
  // email-password.db.test.ts.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const mailer = createCapturingMailer();
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: { ...testLockout(), mailer },
    }),
  );

  const limiter = createRateLimiter({
    backend: createMemoryBackend(),
    log: { error: vi.fn() },
  });
  const handler = createAuthRouteLimiter({
    limiter,
    sessionCookieName: "sgauth-local.session_token",
  })(auth.handler);

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t18-${counter++}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so assertions filter by this run's users.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  const signUp = (email: string) =>
    auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });

  const verifyMessages = (email: string) =>
    mailer.to(email).filter((message) => message.template === "verify-email");

  function resendOverHttp(email: string) {
    return handler(
      new Request(`${BASE_URL}/api/auth/send-verification-email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          "x-forwarded-for": "203.0.113.18",
        },
        body: JSON.stringify({ email }),
      }),
    );
  }

  describe("sending", () => {
    it("mails one verify link to the normalized address on sign-up", async () => {
      const local = `T18-${counter++}-${rand}`;
      await signUp(`  ${local}@Northeastern.EDU `);

      const messages = verifyMessages(`${local}@northeastern.edu`);
      expect(messages).toHaveLength(1);

      const link = new URL(String(messages[0].data.url));
      expect(link.origin + link.pathname).toBe(`${BASE_URL}/verify-email`);
      expect([...link.searchParams.keys()]).toEqual(["token"]);
      const claims = decodeJwt(link.searchParams.get("token") ?? "");
      expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(86_400);
      expect(messages[0].data.expiresInMinutes).toBe(1440);
    });

    it("mails nothing for a repeat sign-up", async () => {
      const email = freshEmail();
      await signUp(email);
      expect(verifyMessages(email)).toHaveLength(1);

      await signUp(email);
      expect(verifyMessages(email)).toHaveLength(1);
    });

    it("refuses an unverified sign-in with the right password and mails nothing", async () => {
      const email = freshEmail();
      await signUp(email);
      mailer.clear();

      const error = await auth.api
        .signInEmail({ body: { email, password: STRONG } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({
        statusCode: 403,
        body: { code: "EMAIL_NOT_VERIFIED" },
      });
      expect(mailer.sent).toHaveLength(0);
    });

    it("does not fail a sign-up when the mailer throws", async () => {
      const failing = betterAuth(
        buildAuthOptions({
          prisma,
          baseURL: BASE_URL,
          secret: SECRET,
          lockout: {
            ...testLockout(),
            mailer: {
              sendEmail: vi.fn().mockRejectedValue(new Error("boom")),
            },
          },
        }),
      );
      const email = freshEmail();
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await failing.api.signUpEmail({
          body: { email, password: STRONG, name: "Test User" },
        });
        expect(quiet).toHaveBeenCalledWith("verification_email_failed", {
          errorName: "Error",
        });
      } finally {
        quiet.mockRestore();
      }
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });
  });

  describe("resend limit", () => {
    it("answers the 4th resend within an hour with 429 and sends nothing", async () => {
      const email = freshEmail();
      await signUp(email);
      mailer.clear();

      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await resendOverHttp(email)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(verifyMessages(email)).toHaveLength(3);

      const limited = await resendOverHttp(email);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
        1,
      );
    });

    it("gives an unknown address the same status sequence", async () => {
      const email = freshEmail();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await resendOverHttp(email)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(mailer.to(email)).toHaveLength(0);
    });

    it("shares the bucket with the expired-link resend", async () => {
      const email = freshEmail();
      await signUp(email);
      mailer.clear();
      const consume = createResendVerifyEmailConsumer({
        auth,
        secret: SECRET,
        limit: async (address) =>
          (await limiter.check("verificationResend", { email: address }))
            .allowed,
      });
      const expired = await createEmailVerificationToken(
        SECRET,
        email,
        undefined,
        -60,
      );
      const request = new Request(`${BASE_URL}/verify-email/resend`, {
        method: "POST",
      });

      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push(
          (await consume({ token: expired, fields: {}, request })).result,
        );
      }
      expect(results).toEqual(["sent", "sent", "sent", "rate"]);
      expect(verifyMessages(email)).toHaveLength(3);

      // The HTTP endpoint draws on the same bucket, so it is already spent.
      expect((await resendOverHttp(email)).status).toBe(429);
    });

    it("mails nothing for the expired-link resend of a verified address", async () => {
      const email = freshEmail();
      await signUp(email);
      await auth.api.verifyEmail({
        query: { token: await createEmailVerificationToken(SECRET, email) },
      });
      mailer.clear();
      const consume = createResendVerifyEmailConsumer({
        auth,
        secret: SECRET,
        limit: async () => true,
      });
      const expired = await createEmailVerificationToken(
        SECRET,
        email,
        undefined,
        -60,
      );

      const outcome = await consume({
        token: expired,
        fields: {},
        request: new Request(`${BASE_URL}/verify-email/resend`),
      });
      expect(outcome).toEqual({ result: "sent" });
      expect(mailer.sent).toHaveLength(0);
    });
  });
});
