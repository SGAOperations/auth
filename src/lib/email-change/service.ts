import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type User,
} from "@/generated/prisma/client";
import { audit, withAuditContext, withAuditTransaction } from "@/lib/audit";
import { can, type AuthzDenialReason, type AuthzSubject } from "@/lib/authz";
import { revokeUnlockTokens } from "@/lib/auth/unlock-token";
import { isAllowedSignupEmail, normalizeEmail } from "@/lib/auth/policy";
import type { Mailer } from "@/lib/email/mailer";
import { tokenLinkUrl } from "@/lib/token-links/actions";

// The two halves of an admin-initiated email change (AUTH-T24). `request` stores
// a pending row and mails the new address; `User.email` changes only in
// `confirm`, which the new mailbox's owner reaches through the scanner-safe
// page. Better Auth's own `changeEmail` stays off: v1 lets no user change their
// own address.

/** 24 hours. */
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/** Lower-case hex SHA-256: the only form of a token that is ever stored. */
export function hashEmailChangeToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface EmailChangeLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface EmailChangeDeps {
  prisma: PrismaClient;
  mailer: Pick<Mailer, "sendEmail">;
  /** The origin every emailed link sits on. */
  linkOrigin: string;
  log: EmailChangeLog;
  now(): Date;
}

export interface RequestEmailChangeInput {
  actor: AuthzSubject;
  targetId: string;
  newEmail: string;
  /** The request's network fields, for the audit row. */
  requestContext: { ip: string | null; userAgent: string | null };
}

export type RequestEmailChangeResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; code: "FORBIDDEN"; reason: AuthzDenialReason }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "USER_DELETED"
        | "EMAIL_UNCHANGED"
        | "EMAIL_UNAVAILABLE"
        | "EMAIL_SEND_LIMITED";
    };

export type PeekEmailChangeResult =
  | { state: "valid"; newEmail: string }
  | { state: "expired" | "used" | "invalid" };

export type ConfirmEmailChangeResult =
  | { state: "done"; newEmail: string }
  | { state: "expired" | "used" | "invalid" | "unavailable" };

/** Thrown inside the confirm transaction so nothing commits. */
class Abort extends Error {
  constructor(readonly state: "invalid" | "unavailable") {
    super(state);
    this.name = "Abort";
  }
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

type Target = Pick<
  User,
  | "id"
  | "email"
  | "name"
  | "preferredName"
  | "isAdmin"
  | "isPrimaryAdmin"
  | "status"
>;

export function createEmailChangeService({
  prisma,
  mailer,
  linkOrigin,
  log,
  now,
}: EmailChangeDeps) {
  /**
   * Validates, stores a pending request and mails both addresses. It never
   * changes `User.email`. An address that is taken is `EMAIL_UNAVAILABLE`
   * whoever owns it, and the result never names the owner.
   */
  async function requestEmailChange({
    actor,
    targetId,
    newEmail: rawEmail,
    requestContext,
  }: RequestEmailChangeInput): Promise<RequestEmailChangeResult> {
    const newEmail = normalizeEmail(rawEmail);

    const target: Target | null = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        email: true,
        name: true,
        preferredName: true,
        isAdmin: true,
        isPrimaryAdmin: true,
        status: true,
      },
    });
    if (!target) return { ok: false, code: "NOT_FOUND" };
    if (target.status === "DELETED") return { ok: false, code: "USER_DELETED" };

    const decision = can(actor, "changeEmail", target);
    if (!decision.allowed) {
      return { ok: false, code: "FORBIDDEN", reason: decision.reason };
    }

    if (newEmail === normalizeEmail(target.email)) {
      return { ok: false, code: "EMAIL_UNCHANGED" };
    }
    const taken = await prisma.user.findUnique({
      where: { email: newEmail },
      select: { id: true },
    });
    if (taken) return { ok: false, code: "EMAIL_UNAVAILABLE" };

    const at = now();
    const expiresAt = new Date(at.getTime() + EMAIL_CHANGE_TTL_MS);
    const token = randomBytes(32).toString("base64url");

    const requestId = await withAuditTransaction(prisma, (tx) =>
      withAuditContext(
        {
          actor: { actorType: "USER", actorUserId: actor.id },
          ip: requestContext.ip,
          userAgent: requestContext.userAgent,
        },
        async () => {
          // One open request per user: a new one replaces the old.
          const open = await tx.emailChangeRequest.findFirst({
            where: { userId: target.id, consumedAt: null, cancelledAt: null },
            select: { id: true },
          });
          if (open) {
            await tx.emailChangeRequest.update({
              where: { id: open.id },
              data: { cancelledAt: at },
            });
          }
          const created = await tx.emailChangeRequest.create({
            data: {
              userId: target.id,
              newEmail,
              tokenHash: hashEmailChangeToken(token),
              requestedById: actor.id,
              expiresAt,
            },
            select: { id: true },
          });
          await audit({
            type: "EMAIL_CHANGE_REQUESTED",
            targetType: "USER",
            targetId: target.id,
            metadata: {
              requestId: created.id,
              fromEmail: target.email,
              toEmail: newEmail,
              ...(open ? { supersededRequestId: open.id } : {}),
            },
          });
          return created.id;
        },
      ),
    );

    const name = target.preferredName ?? target.name;
    const cancelRequest = () =>
      prisma.emailChangeRequest.updateMany({
        where: { id: requestId, consumedAt: null, cancelledAt: null },
        data: { cancelledAt: now() },
      });

    // After the commit, so a link is never mailed that is not stored. The audit
    // row stays when the send is refused: the log is append-only.
    const sent = await mailer
      .sendEmail({
        to: newEmail,
        template: "email-change-verify",
        data: {
          name,
          url: tokenLinkUrl(linkOrigin, "email-change", token),
          expiresInMinutes: EMAIL_CHANGE_TTL_MS / 60_000,
        },
      })
      .catch(async (error: unknown) => {
        await cancelRequest();
        throw error;
      });
    if (sent.status === "capped") {
      await cancelRequest();
      return { ok: false, code: "EMAIL_SEND_LIMITED" };
    }
    if (sent.status === "failed") {
      await cancelRequest();
      throw new Error("The verification email could not be sent");
    }

    // The notice is a courtesy: a refused or failed one never fails the request.
    try {
      const notice = await mailer.sendEmail({
        to: target.email,
        template: "email-change-notice",
        data: { name, newEmail },
      });
      if (notice.status !== "sent") {
        log.error("email_change_notice_not_sent", { status: notice.status });
      }
    } catch (error) {
      log.error("email_change_notice_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }

    return { ok: true, expiresAt };
  }

  /**
   * What the GET page shows. Read-only by construction: it never claims the
   * token, so a scanner pre-fetch consumes nothing. A cancelled request, an
   * unknown token and a deleted user all read as `invalid`.
   */
  async function peekEmailChange(
    token: string,
  ): Promise<PeekEmailChangeResult> {
    const row = await prisma.emailChangeRequest.findUnique({
      where: { tokenHash: hashEmailChangeToken(token) },
      select: {
        newEmail: true,
        expiresAt: true,
        consumedAt: true,
        cancelledAt: true,
        user: { select: { status: true } },
      },
    });
    if (!row || row.cancelledAt || row.user.status === "DELETED") {
      return { state: "invalid" };
    }
    if (row.consumedAt) return { state: "used" };
    if (row.expiresAt <= now()) return { state: "expired" };
    return { state: "valid", newEmail: row.newEmail };
  }

  /**
   * The only place `User.email` changes. One transaction claims the request,
   * swaps the address, signs the user out everywhere, voids the single-use
   * tokens that were mailed to the old address and writes `EMAIL_CHANGED`.
   */
  async function confirmEmailChange(
    token: string,
  ): Promise<ConfirmEmailChangeResult> {
    const tokenHash = hashEmailChangeToken(token);
    const at = now();

    let changed: { newEmail: string } | null;
    try {
      changed = await withAuditTransaction(prisma, async (tx) => {
        // The conditional update is the atomic single-use guard.
        const claimed = await tx.emailChangeRequest.updateMany({
          where: {
            tokenHash,
            consumedAt: null,
            cancelledAt: null,
            expiresAt: { gt: at },
          },
          data: { consumedAt: at },
        });
        if (claimed.count !== 1) return null;

        const request = await tx.emailChangeRequest.findUniqueOrThrow({
          where: { tokenHash },
          select: {
            id: true,
            userId: true,
            newEmail: true,
            requestedById: true,
          },
        });
        const user = await tx.user.findUnique({
          where: { id: request.userId },
          select: { email: true, status: true, legacyEmail: true },
        });
        if (!user || user.status === "DELETED") throw new Abort("invalid");

        const newEmail = normalizeEmail(request.newEmail);
        const legacyEmail = !isAllowedSignupEmail(newEmail);
        try {
          await tx.user.update({
            where: { id: request.userId },
            data: { email: newEmail, emailVerified: true, legacyEmail },
          });
        } catch (err) {
          // Taken while the request was pending. The throw rolls the claim
          // back, so the row stays unconsumed and expires on its own.
          if (isUniqueViolation(err)) throw new Abort("unavailable");
          throw err;
        }

        // Prisma, not Better Auth, so its session hooks add no second audit row.
        const { count: sessionsRevoked } = await tx.session.deleteMany({
          where: { userId: request.userId },
        });
        // Reset and set-password tokens carry the user id as their value; an
        // unlock link was mailed to the old address too.
        await tx.verification.deleteMany({ where: { value: request.userId } });
        await revokeUnlockTokens(tx, request.userId, at);

        await audit({
          type: "EMAIL_CHANGED",
          actorType: "SYSTEM",
          targetType: "USER",
          targetId: request.userId,
          metadata: {
            requestId: request.id,
            requestedById: request.requestedById,
            fromEmail: user.email,
            toEmail: newEmail,
            legacyEmail: { from: user.legacyEmail, to: legacyEmail },
            sessionsRevoked,
          },
        });
        return { newEmail };
      });
    } catch (err) {
      if (err instanceof Abort) return { state: err.state };
      throw err;
    }

    if (changed) return { state: "done", newEmail: changed.newEmail };
    // Nothing was claimed: say why, from the request as it now stands.
    const peeked = await peekEmailChange(token);
    return peeked.state === "valid" ? { state: "invalid" } : peeked;
  }

  return { requestEmailChange, peekEmailChange, confirmEmailChange };
}

export type EmailChangeService = ReturnType<typeof createEmailChangeService>;
