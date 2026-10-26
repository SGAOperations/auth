import { vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { betterAuth } from "better-auth";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import {
  createSetPasswordService,
  type SetPasswordServiceDeps,
} from "@/lib/set-password/service";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { testLockout } from "@/test/lockout-options";

export const SECRET = "s".repeat(32);
export const BASE_URL = "http://localhost:3000";
export const STRONG = "correct-horse-battery-staple";

type LimitPolicy = Parameters<SetPasswordServiceDeps["limit"]>[0];

/**
 * A real Prisma client, real Better Auth options (including the self-sign-up
 * trigger) and the real set-password service, over a capturing mailer. The
 * per-account limit is a switch: `deny("setPasswordLink")` refuses it.
 */
export function createSetPasswordHarness(url: string, prefix: string) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const mailer = createCapturingMailer();
  const denied = new Set<LimitPolicy>();
  const log = { info: vi.fn() };

  const service = createSetPasswordService({
    prisma,
    mailer,
    limit: async (policy) => ({
      allowed: !denied.has(policy),
      retryAfterSeconds: 0,
    }),
    linkOrigin: BASE_URL,
    log,
    now: () => new Date(),
  });

  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: testLockout(),
      onPasswordlessSignUp: (user) => service.requestForUser(user, "sign_up"),
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `${prefix}-${counter++}-${rand}@northeastern.edu`;

  /** An ACTIVE, verified user with no credential Account at all. */
  function createPasswordless(
    overrides: { status?: "ACTIVE" | "DEACTIVATED"; email?: string } = {},
  ) {
    return prisma.user.create({
      data: {
        email: overrides.email ?? freshEmail(),
        name: "Passwordless User",
        emailVerified: true,
        status: overrides.status ?? "ACTIVE",
      },
    });
  }

  async function createWithPassword(password = STRONG) {
    const user = await createPasswordless();
    await prisma.account.create({
      data: {
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(password),
      },
    });
    return user;
  }

  /** The most recent set-password email to `address`, or undefined. */
  const linkTo = (address: string) => mailer.to(address).at(-1);

  /** The raw token in an emailed link. */
  function tokenOf(message: { data: Record<string, unknown> } | undefined) {
    const token = new URL(String(message?.data.url)).searchParams.get("token");
    if (!token) throw new Error("no token in the emailed link");
    return token;
  }

  // Audit rows cannot be deleted, so assertions filter by this run's users.
  async function cleanup() {
    const users = await prisma.user.findMany({
      where: { email: { contains: rand } },
      select: { id: true },
    });
    await prisma.verification.deleteMany({
      where: { value: { in: users.map((user) => user.id) } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  }

  return {
    prisma,
    auth,
    mailer,
    service,
    log,
    rand,
    freshEmail,
    createPasswordless,
    createWithPassword,
    linkTo,
    tokenOf,
    deny: (policy: LimitPolicy) => denied.add(policy),
    allowAll: () => denied.clear(),
    cleanup,
  };
}

export type SetPasswordHarness = ReturnType<typeof createSetPasswordHarness>;
