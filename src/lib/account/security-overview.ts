import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { canDisableMfa } from "@/lib/auth/mfa-policy";
import { logger } from "@/lib/log";

export interface SecurityOverview {
  email: string;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  twoFactorEnabled: boolean;
  /** Whether the user may turn two-factor authentication off. */
  canDisable: boolean;
  /** An admin who has not enrolled yet. */
  mfaRequired: boolean;
  /** Null when two-factor is off or the stored list cannot be read. */
  backupCodesRemaining: number | null;
}

type SecurityDb = {
  user: Pick<PrismaClient["user"], "findUnique">;
  twoFactor: Pick<PrismaClient["twoFactor"], "findFirst">;
};

const storedCodes = z.array(z.string());

/**
 * What `/account/security` shows. Read fresh because `session.user` carries
 * neither the admin flags nor the backup-code list, and the codes are never
 * returned: only how many are left.
 */
export async function loadSecurityOverview(
  db: SecurityDb,
  userId: string,
): Promise<SecurityOverview | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      twoFactorEnabled: true,
      status: true,
    },
  });
  if (!user) return null;

  let backupCodesRemaining: number | null = null;
  if (user.twoFactorEnabled) {
    const row = await db.twoFactor.findFirst({
      where: { userId },
      select: { backupCodes: true },
    });
    if (row) {
      try {
        backupCodesRemaining = storedCodes.parse(
          JSON.parse(row.backupCodes),
        ).length;
      } catch {
        // No error object and no value: the list holds code hashes.
        logger.warn("Backup codes could not be read for the security page");
      }
    }
  }

  return {
    email: user.email,
    isAdmin: user.isAdmin,
    isPrimaryAdmin: user.isPrimaryAdmin,
    twoFactorEnabled: user.twoFactorEnabled,
    canDisable: canDisableMfa(user),
    mfaRequired: user.isAdmin && !user.twoFactorEnabled,
    backupCodesRemaining,
  };
}
