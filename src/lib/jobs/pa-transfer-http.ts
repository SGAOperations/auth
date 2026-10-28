import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { transferErrorResponse } from "@/lib/admin-api";
import { withAuditTransaction } from "@/lib/audit";
import type { Tx, TransferNotice } from "@/lib/jobs/pa-transfer";
import {
  TransferError,
  type TransitionResult,
} from "@/lib/jobs/pa-transfer-actions";
import { notifyTransfer } from "@/lib/jobs/pa-transfer-notify";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// What the transfer routes share after their guards pass: run one transition in
// an audit transaction, turn a refusal into its `{ code, message }` response,
// and send the emails once the transaction has committed.

export const transferIdSchema = z.uuid();

/**
 * Runs `transition` in one transaction. Returns the committed row, or the
 * response for an expected refusal. Anything unexpected is rethrown for
 * `withRequestLogging`, which answers a generic 500.
 */
export async function performTransition(
  transition: (tx: Tx, now: Date) => Promise<TransitionResult>,
): Promise<
  { transfer: TransitionResult["transfer"] } | { response: Response }
> {
  let result: TransitionResult;
  try {
    result = await withAuditTransaction(prisma, (tx) =>
      transition(tx, new Date()),
    );
  } catch (err) {
    if (err instanceof TransferError) {
      return { response: transferErrorResponse(err) };
    }
    // Only creating a transfer can hit a unique index here, and the one that
    // can fire is one_in_flight_primary_admin_transfer: two initiations raced.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        response: transferErrorResponse(
          new TransferError("TRANSFER_IN_FLIGHT"),
        ),
      };
    }
    throw err;
  }

  await sendNotice(result.notice);
  return { transfer: result.transfer };
}

/**
 * Emails a notice once its transaction has committed. A failure is logged and
 * never surfaced: the transfer's status in the app is the source of truth.
 */
export async function sendNotice(notice: TransferNotice): Promise<void> {
  try {
    await notifyTransfer(notice);
  } catch (err) {
    logger.error("pa_transfer.notify_failed", {
      err,
      transferId: notice.transferId,
      kind: notice.kind,
    });
  }
}
