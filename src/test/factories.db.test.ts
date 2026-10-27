import { describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import {
  createAdmin,
  createPosition,
  createPrimaryAdmin,
  createSession,
  createUser,
} from "./factories";
import { useFakeClock } from "./fake-clock";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("db harness", () => {
  // Must stay first: other db files create users, so a non-zero count means
  // the reset before this file did not run. AuditEvent is append-only and a
  // Primary Admin cannot be deleted, so neither is reset or asserted here.
  it("starts every file with empty tables", async () => {
    expect(await prisma.user.count({ where: { isPrimaryAdmin: false } })).toBe(
      0,
    );
    expect(await prisma.session.count()).toBe(0);
  });
});

describe("factories", () => {
  it("createUser returns a verified, active UUID v7 user", async () => {
    const user = await createUser();
    expect(user.id).toMatch(UUID_V7);
    expect(user.status).toBe("ACTIVE");
    expect(user.emailVerified).toBe(true);
    expect(user.isAdmin).toBe(false);
    expect(user.email).toMatch(/@northeastern\.edu$/);
  });

  it("createUser gives distinct emails and honours overrides", async () => {
    const [a, b] = [await createUser(), await createUser()];
    expect(a.email).not.toBe(b.email);

    const named = await createUser({ name: "Named", emailVerified: false });
    expect(named.name).toBe("Named");
    expect(named.emailVerified).toBe(false);
  });

  it("createUser with a password stores a credential Better Auth verifies", async () => {
    const user = await createUser({ password: "correct-horse-battery" });
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(account.providerId).toBe("credential");
    expect(account.password).not.toBe("correct-horse-battery");
    expect(
      await verifyPassword({
        hash: account.password!,
        password: "correct-horse-battery",
      }),
    ).toBe(true);
    expect(
      await verifyPassword({ hash: account.password!, password: "wrong" }),
    ).toBe(false);
  });

  it("createUser without a password creates no Account", async () => {
    const user = await createUser();
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
  });

  it("createAdmin and createPrimaryAdmin set the flags", async () => {
    const admin = await createAdmin();
    expect(admin).toMatchObject({ isAdmin: true, isPrimaryAdmin: false });

    // A committed Primary Admin could never be cleared again, so it is created
    // in a transaction that rolls back. It displaces the harness Primary Admin
    // (when one exists) for that transaction only.
    const primaryAdminIds = async () =>
      (
        await prisma.user.findMany({
          where: { isPrimaryAdmin: true },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => row.id);
    const before = await primaryAdminIds();
    class Rollback extends Error {}
    let primary: Awaited<ReturnType<typeof createPrimaryAdmin>> | undefined;
    await prisma
      .$transaction(async (tx) => {
        primary = await createPrimaryAdmin({}, tx);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(primary).toMatchObject({ isAdmin: true, isPrimaryAdmin: true });
    expect(await primaryAdminIds()).toEqual(before);
  });

  it("createSession measures expiry from the fake clock", async () => {
    const clock = useFakeClock("2026-03-01T00:00:00Z");
    const user = await createUser();
    const session = await createSession(user);
    clock.restore();

    const start = Date.parse("2026-03-01T00:00:00Z");
    expect(session.userId).toBe(user.id);
    expect(session.expiresAt.getTime()).toBe(start + 30 * DAY_MS);
    expect(session.absoluteExpiresAt.getTime()).toBe(start + 90 * DAY_MS);
  });

  it("createPosition returns an active position with a unique key", async () => {
    const [a, b] = [await createPosition(), await createPosition()];
    expect(a.deletedAt).toBeNull();
    expect(a.key).not.toBe(b.key);

    const custom = await createPosition({ key: "custom-key", name: "Custom" });
    expect(custom).toMatchObject({ key: "custom-key", name: "Custom" });
  });
});
