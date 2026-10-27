import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { createUser } from "@/test/factories";
import { testLockout } from "@/test/lockout-options";

// A benchmark, not a test: it reports timing deltas and never fails on them
// (red-team B17). It skips unless `npm run bench:auth-timing` sets the flag.
// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const bench = process.env.AUTH_TIMING_BENCH;
// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const WRONG = "definitely-not-the-password-1";
const WARM_UP = 3;
const ROUNDS = 20;
const FLAG_MS = 50;

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const p90 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1];
const round = (value: number) => Math.round(value * 10) / 10;

describe.skipIf(!bench || !url)("enumeration timing (informational)", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const background: Promise<unknown>[] = [];
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: { ...testLockout(), mailer: createCapturingMailer() },
      advanced: {
        backgroundTasks: { handler: (task) => void background.push(task) },
      },
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t70-bench-${counter++}-${rand}@northeastern.edu`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  const post = async (path: string, body: unknown) => {
    await auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify(body),
      }),
    );
    await Promise.all(background.splice(0));
  };

  async function time(call: () => Promise<void>) {
    const start = performance.now();
    await call();
    return performance.now() - start;
  }

  async function measure(
    name: string,
    a: () => Promise<void>,
    b: () => Promise<void>,
  ) {
    for (let i = 0; i < WARM_UP; i++) {
      await a();
      await b();
    }
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      if (i % 2 === 0) {
        aTimes.push(await time(a));
        bTimes.push(await time(b));
      } else {
        bTimes.push(await time(b));
        aTimes.push(await time(a));
      }
    }
    const delta = median(aTimes) - median(bTimes);
    return {
      pair: name,
      "a median ms": round(median(aTimes)),
      "a p90 ms": round(p90(aTimes)),
      "b median ms": round(median(bTimes)),
      "b p90 ms": round(p90(bTimes)),
      "delta ms": round(delta),
      flag: Math.abs(delta) > FLAG_MS ? `over ${FLAG_MS} ms` : "",
    };
  }

  it("reports the known-versus-unknown timing of each endpoint", async () => {
    const verified = freshEmail();
    await createUser({ email: verified, password: STRONG });
    const unverified = freshEmail();
    await createUser({
      email: unverified,
      password: STRONG,
      emailVerified: false,
    });
    const resetTarget = freshEmail();
    await createUser({ email: resetTarget, password: STRONG });
    const unverifiedForResend = freshEmail();
    await createUser({ email: unverifiedForResend, emailVerified: false });
    const unknown = freshEmail();

    const rows = [
      await measure(
        "sign-in: a unknown, b verified",
        () => post("/sign-in/email", { email: unknown, password: WRONG }),
        () => post("/sign-in/email", { email: verified, password: WRONG }),
      ),
      // Every new-side round signs up a fresh address.
      await measure(
        "sign-up: a new, b existing unverified",
        () =>
          post("/sign-up/email", {
            email: freshEmail(),
            password: STRONG,
            name: "Bench",
          }),
        () =>
          post("/sign-up/email", {
            email: unverified,
            password: STRONG,
            name: "Bench",
          }),
      ),
      await measure(
        "forgot-password: a unknown, b existing",
        () => post("/request-password-reset", { email: unknown }),
        () => post("/request-password-reset", { email: resetTarget }),
      ),
      await measure(
        "resend: a unknown, b unverified",
        () => post("/send-verification-email", { email: unknown }),
        () => post("/send-verification-email", { email: unverifiedForResend }),
      ),
    ];

    console.table(rows);
    expect(rows).toHaveLength(4);
  }, 300_000);
});
