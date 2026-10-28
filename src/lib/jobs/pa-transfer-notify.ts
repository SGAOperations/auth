import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { toAuthSettings } from "@/lib/auth/settings";
import { sendEmail } from "@/lib/email/server";
import type { EmailMessage, Mailer } from "@/lib/email/mailer";
import { env } from "@/lib/env";
import type { TransferNotice, TransferNotifier } from "@/lib/jobs/pa-transfer";
import { logger } from "@/lib/log";
import type { Logger } from "@/lib/log/logger";
import { prisma } from "@/lib/prisma";
import { plainLinkUrl, tokenLinkUrl } from "@/lib/token-links/actions";
import { displayName } from "@/lib/user-display";

// Turns a TransferNotice into emails. One notifier serves the scheduled job and
// the transfer routes, so the wording and the recipients are decided once. The
// notice carries ids only: names and addresses are read here, after commit, so
// they are current and never travel through a log line.

type Db = Pick<PrismaClient, "primaryAdminTransfer" | "user">;

const personSelect = {
  id: true,
  email: true,
  name: true,
  preferredName: true,
  status: true,
} as const;

type CancelledReason = Extract<
  EmailMessage,
  { template: "pa-transfer-cancelled" }
>["data"]["reason"];

// The job stores why it cancelled; the template speaks of who is affected.
const CANCEL_REASONS: Record<
  NonNullable<TransferNotice["reason"]>,
  CancelledReason
> = {
  cancelled: "cancelled",
  declined: "declined",
  recipient_ineligible: "recipient-ineligible",
  sender_not_primary_admin: "cancelled",
};

export interface TransferNotifierDeps {
  db: Db;
  mailer: Pick<Mailer, "sendEmail">;
  /** The origin every emailed link sits on. */
  origin: string;
  log: Pick<Logger, "warn" | "error">;
}

export function createTransferNotifier({
  db,
  mailer,
  origin,
  log,
}: TransferNotifierDeps): TransferNotifier {
  return async function notify(notice) {
    const transfer = await db.primaryAdminTransfer.findUniqueOrThrow({
      where: { id: notice.transferId },
      select: {
        acceptanceExpiresAt: true,
        executesAt: true,
        completedAt: true,
        fromUser: { select: personSelect },
        toUser: { select: personSelect },
      },
    });
    const from = {
      email: transfer.fromUser.email,
      name: displayName(transfer.fromUser),
    };
    const to = {
      email: transfer.toUser.email,
      name: displayName(transfer.toUser),
    };

    const messages: EmailMessage[] = [];
    switch (notice.kind) {
      case "initiated":
        messages.push(
          {
            to: to.email,
            template: "pa-transfer-initiated",
            data: {
              role: "recipient",
              url: plainLinkUrl(origin, "pa-transfer-accept"),
              fromName: from.name,
              acceptBy: transfer.acceptanceExpiresAt,
            },
          },
          {
            to: from.email,
            template: "pa-transfer-initiated",
            data: {
              role: "initiator",
              toName: to.name,
              acceptBy: transfer.acceptanceExpiresAt,
            },
          },
        );
        break;

      case "accepted": {
        if (!notice.cancelToken || !transfer.executesAt) {
          throw new Error("An accepted notice needs a cancel token and a date");
        }
        messages.push(
          {
            to: from.email,
            template: "pa-transfer-accepted",
            data: {
              role: "initiator",
              cancelUrl: tokenLinkUrl(
                origin,
                "pa-transfer-cancel",
                notice.cancelToken,
              ),
              toName: to.name,
              executesAt: transfer.executesAt,
            },
          },
          {
            to: to.email,
            template: "pa-transfer-accepted",
            data: {
              role: "recipient",
              fromName: from.name,
              executesAt: transfer.executesAt,
            },
          },
        );
        break;
      }

      case "cancelled": {
        const reason = CANCEL_REASONS[notice.reason ?? "cancelled"];
        messages.push({
          to: from.email,
          template: "pa-transfer-cancelled",
          data: { role: "initiator", otherName: to.name, reason },
        });
        // A recipient who was deactivated is no longer anyone to write to.
        const recipientReachable =
          notice.reason !== "recipient_ineligible" ||
          transfer.toUser.status === "ACTIVE";
        if (recipientReachable) {
          messages.push({
            to: to.email,
            template: "pa-transfer-cancelled",
            data: { role: "recipient", otherName: from.name, reason },
          });
        }
        break;
      }

      case "expired":
        messages.push({
          to: from.email,
          template: "pa-transfer-cancelled",
          data: { role: "initiator", otherName: to.name, reason: "expired" },
        });
        break;

      case "completed": {
        if (!transfer.completedAt) {
          throw new Error("A completed notice needs a completion date");
        }
        const completion = {
          fromName: from.name,
          toName: to.name,
          completedAt: transfer.completedAt,
        };
        messages.push(
          {
            to: from.email,
            template: "pa-transfer-completed",
            data: { role: "initiator", ...completion },
          },
          {
            to: to.email,
            template: "pa-transfer-completed",
            data: { role: "recipient", ...completion },
          },
        );
        const admins = await db.user.findMany({
          where: {
            status: "ACTIVE",
            isAdmin: true,
            id: { notIn: [notice.fromUserId, notice.toUserId] },
          },
          select: { email: true },
        });
        for (const admin of admins) {
          messages.push({
            to: admin.email,
            template: "pa-transfer-completed",
            data: { role: "admin", ...completion },
          });
        }
        break;
      }
    }

    // One message at a time, so one bad address or a hit cap cannot stop the
    // rest. The state change has committed and is visible in the app, so a
    // message that does not go out is logged, never thrown.
    for (const message of messages) {
      try {
        const result = await mailer.sendEmail(message);
        if (result.status !== "sent") {
          log.warn("pa_transfer.email_not_sent", {
            transferId: notice.transferId,
            template: message.template,
            status: result.status,
          });
        }
      } catch (error) {
        log.error("pa_transfer.email_invalid", {
          transferId: notice.transferId,
          template: message.template,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  };
}

export const notifyTransfer = createTransferNotifier({
  db: prisma,
  mailer: { sendEmail },
  origin: new URL(toAuthSettings(env).baseURL).origin,
  log: logger,
});
