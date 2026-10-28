import { describe, expect, it, vi } from "vitest";
import { symmetricEncrypt } from "better-auth/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { hashBackupCode } from "@/lib/auth/backup-codes";
import { claimTotpStep, verifySecondFactor } from "@/lib/auth/second-factor";
import { currentTotpStep, hotp } from "@/lib/auth/totp";

const KEY = "k".repeat(32);
const SECRET = "s".repeat(32);
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const NOW = new Date("2026-01-01T12:00:00Z");
const STEP = currentTotpStep(NOW.getTime());
const BACKUP = "abcde-12345";

async function row(backupCodes = [hashBackupCode(SECRET, BACKUP)]) {
  return {
    id: "tf1",
    secret: await symmetricEncrypt({ key: KEY, data: TOTP_SECRET }),
    backupCodes: JSON.stringify(backupCodes),
  };
}

function stubs(twoFactorRow: Awaited<ReturnType<typeof row>> | null) {
  const findFirst = vi.fn().mockResolvedValue(twoFactorRow);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const db = { twoFactor: { findFirst } } as unknown as Pick<
    PrismaClient,
    "twoFactor"
  >;
  const tx = { twoFactor: { updateMany } } as unknown as Pick<
    PrismaClient,
    "twoFactor"
  >;
  const logger = { error: vi.fn() };
  const verify = (code: string) =>
    verifySecondFactor(db, {
      userId: "u1",
      code,
      secretConfig: KEY,
      secret: SECRET,
      now: NOW,
      logger,
    });
  return { verify, tx, updateMany, logger };
}

describe("claimTotpStep", () => {
  it("claims only a step newer than the last accepted one", async () => {
    const { tx, updateMany } = stubs(null);
    expect(await claimTotpStep(tx, "tf1", 7)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "tf1",
        OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: 7 } }],
      },
      data: { lastTotpStep: 7 },
    });
  });

  it("reports a replay when no row changed", async () => {
    const { tx, updateMany } = stubs(null);
    updateMany.mockResolvedValue({ count: 0 });
    expect(await claimTotpStep(tx, "tf1", 7)).toBe(false);
  });
});

describe("verifySecondFactor", () => {
  it("accepts a current TOTP and defers the claim", async () => {
    const { verify, tx, updateMany } = stubs(await row());
    const result = await verify(hotp(TOTP_SECRET, STEP));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("totp");
    expect(updateMany).not.toHaveBeenCalled();
    expect(await result.commit(tx)).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong TOTP", async () => {
    const { verify, updateMany } = stubs(await row());
    const wrong = hotp(TOTP_SECRET, STEP + 50);
    expect(await verify(wrong)).toEqual({ ok: false });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a backup code and consumes only that one on commit", async () => {
    const other = hashBackupCode(SECRET, "zzzzz-99999");
    const stored = await row([hashBackupCode(SECRET, BACKUP), other]);
    const { verify, tx, updateMany } = stubs(stored);
    const result = await verify(BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("backup_code");
    expect(updateMany).not.toHaveBeenCalled();
    expect(await result.commit(tx)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "tf1", backupCodes: stored.backupCodes },
      data: { backupCodes: JSON.stringify([other]) },
    });
  });

  it("reports a backup code spent by a concurrent request", async () => {
    const { verify, tx, updateMany } = stubs(await row());
    updateMany.mockResolvedValue({ count: 0 });
    const result = await verify(BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.commit(tx)).toBe(false);
  });

  it("rejects an unknown backup code and unreadable stored codes", async () => {
    expect(await stubs(await row()).verify("nope-00000")).toEqual({
      ok: false,
    });
    const broken = { ...(await row()), backupCodes: "not json" };
    expect(await stubs(broken).verify(BACKUP)).toEqual({ ok: false });
  });

  it("logs and rejects when an enrolled user has no TwoFactor row", async () => {
    const { verify, logger } = stubs(null);
    expect(await verify("123456")).toEqual({ ok: false });
    expect(logger.error).toHaveBeenCalledWith("reauth_two_factor_row_missing", {
      userId: "u1",
    });
  });
});
