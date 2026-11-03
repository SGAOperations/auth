import { describe, expect, it, vi } from "vitest";
import { reclaimUnverifiedAccount } from "@/lib/auth/repeat-signup";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "@/lib/auth/policy";

const USER = "u-existing";
const NOW = new Date("2026-11-01T12:00:00Z");

function setup({ userClaimed = 1, passwordsCleared = 1 } = {}) {
  const tx = {
    user: { updateMany: vi.fn(async () => ({ count: userClaimed })) },
    account: { updateMany: vi.fn(async () => ({ count: passwordsCleared })) },
    passkey: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    verification: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const run = () =>
    reclaimUnverifiedAccount(prisma as never, { userId: USER, now: NOW });
  return { tx, run };
}

describe("reclaimUnverifiedAccount", () => {
  it("removes the password, sessions and passkeys and revokes the verify links", async () => {
    const { tx, run } = setup();
    expect(await run()).toBe(true);

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER, emailVerified: false, status: "ACTIVE" },
      data: { updatedAt: NOW },
    });
    // Neither registrant's password survives.
    expect(tx.account.updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER,
        providerId: "credential",
        password: { not: null },
      },
      data: { password: null },
    });
    expect(tx.passkey.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    expect(tx.verification.create).toHaveBeenCalledWith({
      data: {
        identifier: `verify-cutoff:${USER}`,
        value: USER,
        createdAt: NOW,
        expiresAt: new Date(
          NOW.getTime() + VERIFICATION_TOKEN_TTL_SECONDS * 1000,
        ),
      },
    });
  });

  it("leaves a verified, inactive or unknown account alone", async () => {
    const { tx, run } = setup({ userClaimed: 0 });
    expect(await run()).toBe(false);
    expect(tx.account.updateMany).not.toHaveBeenCalled();
    expect(tx.verification.create).not.toHaveBeenCalled();
  });

  it("leaves an account with no password to the set-password path", async () => {
    const { tx, run } = setup({ passwordsCleared: 0 });
    expect(await run()).toBe(false);
    expect(tx.passkey.deleteMany).not.toHaveBeenCalled();
    expect(tx.verification.create).not.toHaveBeenCalled();
  });
});
