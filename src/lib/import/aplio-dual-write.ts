import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { audit, withAuditTransaction } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { prisma } from "@/lib/prisma";
import { planAplioRow } from "@/lib/import/aplio";
import {
  createAplioDualWriteHandler,
  type AplioProvisionResult,
} from "@/lib/import/aplio-dual-write-http";

// The SGAuth side of Aplio's dual write. Uses the same per-row decision as the
// import (planAplioRow), so a dual-written user is indistinguishable from an
// imported one: verified, password-less, never admin. Writes no Account and no
// Verification row, and sends no mail: the user sets a password through the
// set-password flow when they first sign in.

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

async function attempt(
  db: PrismaClient,
  input: { email: string; name: string | null },
): Promise<AplioProvisionResult> {
  return withAuditTransaction(db, async (tx): Promise<AplioProvisionResult> => {
    const existing = await tx.user.findUnique({
      where: { email: input.email },
      select: { id: true, status: true, emailVerified: true },
    });
    const decision = planAplioRow(input, existing ?? undefined);
    if (decision.outcome === "skip") {
      return {
        status:
          decision.reason === "tombstoned in SGAuth"
            ? "tombstoned"
            : "unverified",
      };
    }
    if (decision.outcome === "merge") {
      return { status: "existing", userId: decision.userId };
    }
    const created = await tx.user.create({
      data: decision.create,
      select: { id: true },
    });
    await audit({
      type: "USER_CREATED",
      actorType: "SYSTEM",
      targetType: "USER",
      targetId: created.id,
      metadata: { source: "aplio_dual_write" },
    });
    return { status: "created", userId: created.id };
  });
}

/**
 * Creates the SGAuth user for an Aplio signup, or returns the one that exists.
 * Idempotent, so Aplio may retry freely. A concurrent call for the same address
 * loses the unique index race; it re-reads once and finds the winner.
 */
export async function provisionAplioUser(
  db: PrismaClient,
  input: { email: string; name: string | null },
): Promise<AplioProvisionResult> {
  try {
    return await attempt(db, input);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return attempt(db, input);
  }
}

/** The route handler for `POST /api/provision/aplio/users`. */
export const aplioDualWriteRoute = withRequestLogging(
  "/api/provision/aplio/users",
  createAplioDualWriteHandler({
    secret: env.APLIO_DUAL_WRITE_SECRET,
    cutoverAt: env.APLIO_READ_CUTOVER_AT,
    provision: ({ email, name }) => provisionAplioUser(prisma, { email, name }),
    log: logger,
    now: () => new Date(),
  }),
  logger,
);
