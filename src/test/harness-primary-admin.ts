import { hashPassword } from "better-auth/crypto";
import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const HARNESS_PRIMARY_ADMIN_EMAIL =
  "harness-primary-admin@sgauth-test.invalid";

/**
 * Makes the harness user the Primary Admin of the test branch and gives it a
 * fresh credential for `password`. Idempotent: it adopts the harness user when
 * it already holds the flag, and otherwise moves the flag to it.
 *
 * This is the only committed Primary Admin in the db project. The endpoints
 * and the Better Auth sign-in flow run on their own connections, so they can
 * only see a committed one, and a committed one can never be removed again:
 * `protect_primary_admin` blocks deleting it and `primary_admin_must_exist`
 * blocks clearing it without a replacement. It therefore survives every reset.
 *
 * It moves the flag on the **test branch** away from whoever held it, and the
 * next reset deletes that former holder. That is why `TEST_*` must never point
 * at a branch whose data matters (`resolveTestDatabase` already enforces it).
 */
export async function ensureHarnessPrimaryAdmin({
  password,
}: {
  password: string;
}): Promise<User> {
  const user = await prisma.$transaction(async (tx) => {
    const current = await tx.$queryRaw<{ id: string; email: string }[]>`
      SELECT "id", "email" FROM "User" WHERE "isPrimaryAdmin" FOR UPDATE`;
    const holder = current[0];
    if (holder?.email === HARNESS_PRIMARY_ADMIN_EMAIL) {
      return tx.user.findUniqueOrThrow({ where: { id: holder.id } });
    }

    const harness = await tx.user.upsert({
      where: { email: HARNESS_PRIMARY_ADMIN_EMAIL },
      create: {
        email: HARNESS_PRIMARY_ADMIN_EMAIL,
        name: "Harness Primary Admin",
        isAdmin: true,
        status: "ACTIVE",
        emailVerified: true,
      },
      update: { isAdmin: true, status: "ACTIVE", emailVerified: true },
    });
    if (holder) {
      // The unique index cannot be deferred: clear first, then set.
      await tx.$executeRaw`SELECT set_config('sgauth.pa_transfer', 'on', true)`;
      await tx.user.update({
        where: { id: holder.id },
        data: { isPrimaryAdmin: false },
      });
    }
    return tx.user.update({
      where: { id: harness.id },
      data: { isPrimaryAdmin: true },
    });
  });

  // The reset deletes every Account row, so the credential is rebuilt here.
  await prisma.account.deleteMany({
    where: { userId: user.id, providerId: "credential" },
  });
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
