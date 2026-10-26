import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { audit, withAuditTransaction } from "@/lib/audit";
import { normalizeEmail } from "@/lib/auth/policy";
import type { Mailer } from "@/lib/email/mailer";
import type { CheckResult } from "@/lib/rate-limit/limiter";
import { tokenLinkUrl } from "@/lib/token-links/actions";
import { issueSetPasswordToken } from "@/lib/set-password/token";

/** What caused a link to be requested. */
export type SetPasswordVia = "sign_in" | "sign_up" | "link_request";

export interface SetPasswordUser {
  id: string;
  email: string;
  name: string;
  preferredName?: string | null;
}

export type AdminInviteResult =
  | { ok: true; url: string; expiresInMinutes: number }
  | { ok: false; reason: "RATE_LIMITED" };

export interface SetPasswordLog {
  info(msg: string, fields?: Record<string, unknown>): void;
}

export interface SetPasswordServiceDeps {
  prisma: PrismaClient;
  mailer: Pick<Mailer, "sendEmail">;
  /** Keyed on the account, so a flood to one address cannot spend its mail. */
  limit(
    policy: "setPasswordLink" | "setPasswordInvite",
    userId: string,
  ): Promise<CheckResult>;
  /** The origin every emailed link sits on. */
  linkOrigin: string;
  log: SetPasswordLog;
  now(): Date;
}

type PasswordDb = Pick<Prisma.TransactionClient, "account">;

/**
 * Where-clause of a credential account that holds a password. Shared with the
 * admin endpoints and the admin list, so "Password not set" means one thing.
 */
export function credentialPasswordWhere(
  userId: string,
): Prisma.AccountWhereInput {
  return { userId, providerId: "credential", password: { not: null } };
}

/**
 * "Password-less" is the absence of a credential account with a non-null
 * password: the state imports and admin-created accounts start in.
 */
export async function hasPassword(
  db: PasswordDb,
  userId: string,
): Promise<boolean> {
  return (
    (await db.account.count({ where: credentialPasswordWhere(userId) })) > 0
  );
}

/**
 * The set-password logic behind its three triggers (the login email step, the
 * expired-link form and a self-sign-up of an existing address) and the admin
 * invite primitive.
 */
export function createSetPasswordService({
  prisma,
  mailer,
  limit,
  linkOrigin,
  log,
  now,
}: SetPasswordServiceDeps) {
  /**
   * Does nothing, silently, unless the address belongs to an ACTIVE account
   * with no password. The caller shows the same response either way.
   */
  async function requestLink({
    email,
    via,
  }: {
    email: string;
    via: Exclude<SetPasswordVia, "sign_up">;
  }): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        name: true,
        preferredName: true,
        status: true,
      },
    });
    if (!user || user.status !== "ACTIVE") return;
    if (await hasPassword(prisma, user.id)) return;
    await requestForUser(user, via);
  }

  /** Issues and emails a first-sign-in link, within the per-account limit. */
  async function requestForUser(
    user: SetPasswordUser,
    via: SetPasswordVia,
  ): Promise<void> {
    const allowed = await limit("setPasswordLink", user.id);
    if (!allowed.allowed) {
      log.info("set_password_link_limited", { via });
      return;
    }

    const issued = await withAuditTransaction(prisma, async (tx) => {
      const result = await issueSetPasswordToken(tx, {
        userId: user.id,
        kind: "first-sign-in",
        now: now(),
      });
      await audit({
        type: "PASSWORD_SET_REQUESTED",
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: user.id,
        metadata: { via },
      });
      return result;
    });

    // After the commit, so a link is never mailed that is not stored. A
    // `capped` or `failed` result is already logged by the mailer.
    await mailer.sendEmail({
      to: user.email,
      template: "set-password",
      data: {
        name: user.preferredName ?? user.name,
        url: tokenLinkUrl(linkOrigin, "set-password", issued.token),
        expiresInMinutes: issued.expiresInMinutes,
        kind: "first-sign-in",
      },
    });
  }

  /**
   * Mints a 7-day link for an admin to send. Writes no audit row and sends no
   * email: the admin endpoint owns `USER_INVITED` and the send, and checks that
   * the user is ACTIVE and password-less first. A stray invite to a user who
   * already has a password is harmless, because the consumer refuses it.
   */
  async function issueAdminInvite(
    db: Pick<Prisma.TransactionClient, "verification">,
    { userId, now: at }: { userId: string; now: Date },
  ): Promise<AdminInviteResult> {
    const allowed = await limit("setPasswordInvite", userId);
    if (!allowed.allowed) return { ok: false, reason: "RATE_LIMITED" };
    const { token, expiresInMinutes } = await issueSetPasswordToken(db, {
      userId,
      kind: "admin-invite",
      now: at,
    });
    return {
      ok: true,
      url: tokenLinkUrl(linkOrigin, "set-password", token),
      expiresInMinutes,
    };
  }

  return { requestLink, requestForUser, issueAdminInvite, hasPassword };
}

export type SetPasswordService = ReturnType<typeof createSetPasswordService>;
