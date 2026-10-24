import { describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { createAdmin } from "./factories";
import {
  ensureHarnessPrimaryAdmin,
  HARNESS_PRIMARY_ADMIN_EMAIL,
} from "./harness-primary-admin";

async function primaryAdminEmails(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { isPrimaryAdmin: true },
    select: { email: true },
  });
  return rows.map((row) => row.email);
}

async function credentialMatches(userId: string, password: string) {
  const accounts = await prisma.account.findMany({
    where: { userId, providerId: "credential" },
  });
  expect(accounts).toHaveLength(1);
  return verifyPassword({ hash: accounts[0].password!, password });
}

describe("ensureHarnessPrimaryAdmin", () => {
  it("leaves exactly one Primary Admin, the harness user", async () => {
    const user = await ensureHarnessPrimaryAdmin({ password: "first-pass-1" });
    expect(user).toMatchObject({
      email: HARNESS_PRIMARY_ADMIN_EMAIL,
      isAdmin: true,
      isPrimaryAdmin: true,
      status: "ACTIVE",
    });
    expect(await primaryAdminEmails()).toEqual([HARNESS_PRIMARY_ADMIN_EMAIL]);
  });

  it("is idempotent and refreshes the credential", async () => {
    const first = await ensureHarnessPrimaryAdmin({ password: "first-pass-1" });
    const second = await ensureHarnessPrimaryAdmin({
      password: "second-pass-2",
    });
    expect(second.id).toBe(first.id);
    expect(await primaryAdminEmails()).toEqual([HARNESS_PRIMARY_ADMIN_EMAIL]);
    expect(await credentialMatches(second.id, "second-pass-2")).toBe(true);
    expect(await credentialMatches(second.id, "first-pass-1")).toBe(false);
  });

  it("adopts the flag from a different Primary Admin", async () => {
    await ensureHarnessPrimaryAdmin({ password: "adopt-pass-1" });
    const other = await createAdmin();

    // Hand the flag to another admin the way a transfer does, then let the
    // harness take it back.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('sgauth.pa_transfer', 'on', true)`;
      await tx.user.updateMany({
        where: { isPrimaryAdmin: true },
        data: { isPrimaryAdmin: false },
      });
      await tx.user.update({
        where: { id: other.id },
        data: { isPrimaryAdmin: true },
      });
    });
    expect(await primaryAdminEmails()).toEqual([other.email]);

    const user = await ensureHarnessPrimaryAdmin({ password: "adopt-pass-2" });
    expect(await primaryAdminEmails()).toEqual([HARNESS_PRIMARY_ADMIN_EMAIL]);
    expect(await credentialMatches(user.id, "adopt-pass-2")).toBe(true);
  });
});
