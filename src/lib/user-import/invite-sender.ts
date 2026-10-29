import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import type { Mailer } from "@/lib/email/mailer";
import type { AdminInviteResult } from "@/lib/set-password/service";
import type { InviteAttempt } from "@/lib/user-import/invites";

export interface InviteSenderDeps {
  prisma: Pick<PrismaClient, "user" | "verification">;
  /** Mints the set-password token. Writes no audit row, sends no email. */
  issueAdminInvite(
    db: Pick<PrismaClient, "verification">,
    input: { userId: string; now: Date },
  ): Promise<AdminInviteResult>;
  mailer: Pick<Mailer, "sendEmail">;
  log: { error(msg: string, fields?: Record<string, unknown>): void };
  now(): Date;
}

/**
 * The admin invite the user list's "resend invite" sends, for one user and
 * outside any import transaction. `USER_INVITED` is written only once the mail
 * has gone out, so a user whose send was capped or failed is not counted as
 * invited and the next import reaches them again.
 */
export function createInviteSender(deps: InviteSenderDeps) {
  return async function sendInvite(
    userId: string,
    actorId: string,
  ): Promise<InviteAttempt> {
    const user = await deps.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, preferredName: true },
    });
    if (!user) return { status: "failed" };

    const invite = await deps.issueAdminInvite(deps.prisma, {
      userId,
      now: deps.now(),
    });
    if (!invite.ok) return { status: "rate_limited" };

    const result = await deps.mailer.sendEmail({
      to: user.email,
      template: "set-password",
      data: {
        name: user.preferredName ?? user.name,
        url: invite.url,
        expiresInMinutes: invite.expiresInMinutes,
        kind: "admin-invite",
      },
    });
    if (result.status !== "sent") return result;

    try {
      await audit({
        type: "USER_INVITED",
        actorType: "USER",
        actorUserId: actorId,
        targetType: "USER",
        targetId: userId,
      });
    } catch {
      // The mail is already out, so the send is reported as it happened.
      deps.log.error("user_import_invite_audit_failed", { userId });
    }
    return result;
  };
}

export type InviteSender = ReturnType<typeof createInviteSender>;
