import { afterAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { createUser } from "@/test/factories";
import { testLockout } from "@/test/lockout-options";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const WRONG = "definitely-not-the-password-1";
const NAME = "Enumeration Test";
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// What the response is allowed to carry beyond status and body: Better Auth
// adds `date`, and the length follows the address.
const IGNORED_HEADERS = new Set(["date", "content-length"]);

interface Sample {
  status: number;
  headers: string[];
  body: unknown;
}

describe.skipIf(!url)("account-enumeration resistance", () => {
  // Own client and auth instance with the real options, as in
  // email-verification.db.test.ts.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  // Background tasks are held, as in production, and awaited by `settle`.
  const background: Promise<unknown>[] = [];
  const advanced = {
    backgroundTasks: {
      handler: (task: Promise<unknown>) => void background.push(task),
    },
  };
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: { ...testLockout(), mailer: createCapturingMailer() },
      advanced,
    }),
  );
  const failingAuth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: {
        ...testLockout(),
        mailer: { sendEmail: vi.fn().mockRejectedValue(new Error("boom")) },
      },
      advanced,
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  // Fixed width, so a longer address never explains a difference.
  const freshEmail = () =>
    `t70-${String(counter++).padStart(3, "0")}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so assertions never read them.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function settle() {
    await Promise.all(background.splice(0));
  }

  const existing = (overrides: Parameters<typeof createUser>[0] = {}) => {
    const email = freshEmail();
    return createUser({ email, name: NAME, ...overrides }).then(() => email);
  };

  async function post(
    instance: typeof auth,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const response = await instance.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify(body),
      }),
    );
    await settle();
    return response;
  }

  // The user object of a sign-up answer, with the fields that must differ
  // between requests checked and then masked.
  function maskUser(body: unknown, email: string): unknown {
    if (typeof body !== "object" || body === null || !("user" in body)) {
      return body;
    }
    const user = { ...(body.user as Record<string, unknown>) };
    expect(user.id).toMatch(UUID_V7);
    expect(user.email).toBe(email);
    for (const key of ["createdAt", "updatedAt"]) {
      const stamp = Date.parse(String(user[key]));
      expect(Math.abs(stamp - Date.now())).toBeLessThan(60_000);
      user[key] = "<ts>";
    }
    return { ...body, user: { ...user, id: "<id>", email: "<email>" } };
  }

  async function sample(response: Response, email: string): Promise<Sample> {
    const headers = [...response.headers.keys()]
      .filter((name) => !IGNORED_HEADERS.has(name))
      .sort();
    expect(headers).not.toContain("set-cookie");
    return {
      status: response.status,
      headers,
      body: maskUser(await response.json(), email),
    };
  }

  async function expectIndistinguishable(
    responses: { response: Response; email: string }[],
  ) {
    const samples = await Promise.all(
      responses.map(({ response, email }) => sample(response, email)),
    );
    for (const other of samples.slice(1)) {
      expect(other).toEqual(samples[0]);
    }
    return samples[0];
  }

  const signIn = (email: string, password = WRONG, instance = auth) =>
    post(instance, "/sign-in/email", { email, password });
  const signUp = (email: string, instance = auth) =>
    post(instance, "/sign-up/email", { email, password: STRONG, name: NAME });
  const forgot = (email: string, instance = auth) =>
    post(instance, "/request-password-reset", { email });
  const resend = (email: string, instance = auth) =>
    post(instance, "/send-verification-email", { email });

  describe("sign-in with a wrong password", () => {
    it("answers 401 INVALID_EMAIL_OR_PASSWORD for every kind of account", async () => {
      const unknown = freshEmail();
      const verified = await existing({ password: STRONG });
      const unverified = await existing({
        password: STRONG,
        emailVerified: false,
      });
      const deactivated = await existing({
        password: STRONG,
        status: "DEACTIVATED",
      });
      const noCredential = await existing();

      const answer = await expectIndistinguishable(
        await Promise.all(
          [unknown, verified, unverified, deactivated, noCredential].map(
            async (email) => ({ response: await signIn(email), email }),
          ),
        ),
      );

      expect(answer.status).toBe(401);
      expect(answer.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    });

    // Better Auth hashes a dummy password for an unknown email so that the
    // timing matches; a version that drops it fails here.
    it("hashes a password once for an unknown email", async () => {
      const hash = vi.spyOn((await auth.$context).password, "hash");
      try {
        await signIn(freshEmail());
        expect(hash).toHaveBeenCalledTimes(1);
      } finally {
        hash.mockRestore();
      }
    });
  });

  describe("sign-up", () => {
    it("answers a new address and an existing one alike", async () => {
      const fresh = freshEmail();
      const unverified = await existing({ emailVerified: false });
      const verified = await existing();
      const deactivated = await existing({ status: "DEACTIVATED" });

      const answer = await expectIndistinguishable(
        await Promise.all(
          [fresh, unverified, verified, deactivated].map(async (email) => ({
            response: await signUp(email),
            email,
          })),
        ),
      );

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        token: null,
        user: { status: "ACTIVE", emailVerified: false, name: NAME },
      });
    });
  });

  describe("forgot-password", () => {
    it("answers an unknown, an active and a deactivated address alike", async () => {
      const unknown = freshEmail();
      const active = await existing({ password: STRONG });
      const deactivated = await existing({
        password: STRONG,
        status: "DEACTIVATED",
      });

      const answer = await expectIndistinguishable(
        await Promise.all(
          [unknown, active, deactivated].map(async (email) => ({
            response: await forgot(email),
            email,
          })),
        ),
      );

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ status: true });
    });
  });

  describe("verification resend", () => {
    it("answers an unknown, an unverified and a verified address alike", async () => {
      const unknown = freshEmail();
      const unverified = await existing({ emailVerified: false });
      const verified = await existing();

      const answer = await expectIndistinguishable(
        await Promise.all(
          [unknown, unverified, verified].map(async (email) => ({
            response: await resend(email),
            email,
          })),
        ),
      );

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ status: true });
    });
  });

  describe("a failing mailer", () => {
    it("never reaches the response of forgot-password or resend", async () => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const unknown = freshEmail();
        const active = await existing({ password: STRONG });
        const unverified = await existing({ emailVerified: false });

        const reset = await expectIndistinguishable(
          await Promise.all(
            [unknown, active].map(async (email) => ({
              response: await forgot(email, failingAuth),
              email,
            })),
          ),
        );
        const verification = await expectIndistinguishable(
          await Promise.all(
            [unknown, unverified].map(async (email) => ({
              response: await resend(email, failingAuth),
              email,
            })),
          ),
        );

        expect(reset.status).toBe(200);
        expect(verification.status).toBe(200);
      } finally {
        quiet.mockRestore();
      }
    });
  });
});
