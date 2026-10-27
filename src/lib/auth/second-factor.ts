import "server-only";
import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { hashBackupCode } from "@/lib/auth/backup-codes";
import { classifySecondFactor } from "@/lib/auth/reauth-policy";
import { matchTotpStep } from "@/lib/auth/totp";

// The second factor of a re-authentication: a TOTP or a backup code, verified
// without writing anything. The caller commits the claim in the transaction
// that stamps the session, so a wrong password never burns a code.

type ReadDb = Pick<PrismaClient, "twoFactor">;
type ClaimDb = Pick<Prisma.TransactionClient, "twoFactor">;

const backupCodeList = z.array(z.string());

/**
 * Records `step` as the last accepted TOTP step. The conditional update is the
 * atomic claim: of two concurrent requests with one code, exactly one sees a
 * changed row. Sign-in and re-auth share it, so a code accepted at one cannot
 * be replayed at the other.
 */
export async function claimTotpStep(
  db: ClaimDb,
  twoFactorId: string,
  step: number,
): Promise<boolean> {
  const claimed = await db.twoFactor.updateMany({
    where: {
      id: twoFactorId,
      OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }],
    },
    data: { lastTotpStep: step },
  });
  return claimed.count === 1;
}

export type SecondFactorResult =
  | { ok: false }
  | {
      ok: true;
      method: "totp" | "backup_code";
      /** Claims the code. False means a replay or a concurrent use. */
      commit: (tx: ClaimDb) => Promise<boolean>;
    };

interface SecondFactorInput {
  userId: string;
  code: string;
  /** Better Auth's `ctx.context.secretConfig`, which decrypts the TOTP secret. */
  secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"];
  /** The auth secret; keys the backup-code hashes. */
  secret: string;
  now: Date;
  logger: { error: (message: string, ...args: unknown[]) => void };
}

export async function verifySecondFactor(
  db: ReadDb,
  { userId, code, secretConfig, secret, now, logger }: SecondFactorInput,
): Promise<SecondFactorResult> {
  const row = await db.twoFactor.findFirst({
    where: { userId },
    select: { id: true, secret: true, backupCodes: true },
  });
  if (!row) {
    // `twoFactorEnabled` without a TwoFactor row is inconsistent data.
    logger.error("reauth_two_factor_row_missing", { userId });
    return { ok: false };
  }

  if (classifySecondFactor(code) === "totp") {
    const totpSecret = await symmetricDecrypt({
      key: secretConfig,
      data: row.secret,
    });
    const step = matchTotpStep(totpSecret, code, now.getTime());
    if (step === null) return { ok: false };
    return {
      ok: true,
      method: "totp",
      commit: (tx) => claimTotpStep(tx, row.id, step),
    };
  }

  const stored = backupCodeList.safeParse(safeJson(row.backupCodes));
  if (!stored.success) return { ok: false };
  const hash = hashBackupCode(secret, code);
  if (!stored.data.includes(hash)) return { ok: false };
  const rest = stored.data.filter((entry) => entry !== hash);
  return {
    ok: true,
    method: "backup_code",
    // Compare-and-swap on the stored text, so a code is single use under
    // concurrency.
    commit: async (tx) => {
      const updated = await tx.twoFactor.updateMany({
        where: { id: row.id, backupCodes: row.backupCodes },
        data: { backupCodes: JSON.stringify(rest) },
      });
      return updated.count === 1;
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
