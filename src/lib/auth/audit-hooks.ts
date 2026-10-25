import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  resolveChallengeUserId,
  type ChallengeContext,
} from "@/lib/auth/two-factor-challenge";
import {
  AUDIT_CATALOG,
  audit,
  auditIp,
  type AuditCall,
  type AuditEventType,
} from "@/lib/audit";

// The part of Better Auth's hook context these adapters read. Declared here so
// they do not depend on the internal context types.
interface HookContext {
  path?: string;
  headers?: Headers;
  request?: Request;
  body?: unknown;
  context: {
    logger: { error: (message: string, ...args: unknown[]) => void };
    session?: { user: { id: string } } | null;
    newSession?: { user: { id: string } } | null;
    returned?: unknown;
  };
}

interface HookUser {
  id: string;
  twoFactorEnabled?: boolean | null;
}

interface HookSession {
  id: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const bodyWithEmail = z.looseObject({ email: z.string() });
const changePasswordBody = z.looseObject({
  revokeOtherSessions: z.boolean().optional(),
});
const errorBody = z.looseObject({ code: z.string() });
const userBody = z.looseObject({ user: z.looseObject({ id: z.string() }) });
const loginFailedReason = AUDIT_CATALOG.LOGIN_FAILED.metadata.shape.reason;

const LOGIN_METHODS: Record<
  string,
  "password" | "email_verification" | "totp" | "backup_code"
> = {
  "/sign-in/email": "password",
  "/verify-email": "email_verification",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
};

const WRONG_SECOND_FACTOR_CODES: readonly string[] = [
  "INVALID_CODE",
  "INVALID_BACKUP_CODE",
];

/**
 * Adapters from Better Auth hooks to catalog events. Auth state has already
 * committed when a hook fires, and throwing would turn a completed sign-in
 * into a 500 (or an error oracle), so each adapter logs and continues.
 */
export function createAuthAuditHooks(prisma: PrismaClient) {
  async function emit<T extends AuditEventType>(
    ctx: HookContext | null | undefined,
    event: AuditCall<T>,
    headers: Headers | undefined = ctx?.headers ?? ctx?.request?.headers,
  ) {
    try {
      await audit(event, { db: prisma, headers });
    } catch {
      // The error can carry metadata, so only the type is logged.
      const message = "Failed to write audit event";
      if (ctx) ctx.context.logger.error(message, { type: event.type });
      else console.error(message, { type: event.type });
    }
  }

  async function userIdByEmail(body: unknown) {
    const parsed = bodyWithEmail.safeParse(body);
    if (!parsed.success) return null;
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  async function afterSignInEmail(ctx: HookContext) {
    const returned = ctx.context.returned;
    if (!isAPIError(returned)) return;
    const code = errorBody.safeParse(returned.body);
    const reason = loginFailedReason.safeParse(
      code.success ? code.data.code : undefined,
    );
    const userId = await userIdByEmail(ctx.body);
    await emit(ctx, {
      type: "LOGIN_FAILED",
      actorType: "SYSTEM",
      metadata: { reason: reason.success ? reason.data : "OTHER" },
      ...(userId ? { targetType: "USER" as const, targetId: userId } : {}),
    });
  }

  async function afterRequestPasswordReset(ctx: HookContext) {
    if (isAPIError(ctx.context.returned)) return;
    const userId = await userIdByEmail(ctx.body);
    if (!userId) return;
    await emit(ctx, {
      type: "PASSWORD_RESET_REQUESTED",
      actorType: "SYSTEM",
      targetType: "USER",
      targetId: userId,
    });
  }

  async function afterChangePassword(ctx: HookContext) {
    const session = ctx.context.session ?? ctx.context.newSession;
    if (!session) return;
    const body = changePasswordBody.safeParse(ctx.body);
    await emit(ctx, {
      type: "PASSWORD_CHANGED",
      actorType: "USER",
      actorUserId: session.user.id,
      targetType: "USER",
      targetId: session.user.id,
      metadata: {
        revokedOtherSessions: body.success
          ? body.data.revokeOtherSessions === true
          : false,
      },
    });
  }

  async function afterRevokeSessions(
    ctx: HookContext,
    scope: "all" | "others",
  ) {
    const session = ctx.context.session ?? ctx.context.newSession;
    if (!session) return;
    await emit(ctx, {
      type: "SESSIONS_REVOKED",
      actorType: "USER",
      actorUserId: session.user.id,
      targetType: "USER",
      targetId: session.user.id,
      metadata: { scope },
    });
  }

  // A second-factor request with no session is the sign-in step, so a failure
  // is a failed login. With a session it is enrollment, which is not.
  async function afterSecondFactorVerify(
    ctx: HookContext & ChallengeContext,
    path: "/two-factor/verify-totp" | "/two-factor/verify-backup-code",
  ) {
    const returned = ctx.context.returned;
    if (isAPIError(returned)) {
      if (ctx.context.session) return;
      const code = errorBody.safeParse(returned.body);
      const reason = WRONG_SECOND_FACTOR_CODES.includes(
        code.success ? code.data.code : "",
      )
        ? "INVALID_TWO_FACTOR_CODE"
        : "OTHER";
      const userId = await resolveChallengeUserId(ctx);
      await emit(ctx, {
        type: "LOGIN_FAILED",
        actorType: "SYSTEM",
        metadata: { reason },
        ...(userId ? { targetType: "USER" as const, targetId: userId } : {}),
      });
      return;
    }
    if (path !== "/two-factor/verify-backup-code") return;
    const user = userBody.safeParse(returned);
    if (!user.success) return;
    await emit(ctx, {
      type: "MFA_BACKUP_USED",
      actorType: "USER",
      actorUserId: user.data.user.id,
      targetType: "USER",
      targetId: user.data.user.id,
    });
  }

  async function afterGenerateBackupCodes(ctx: HookContext) {
    const session = ctx.context.session;
    if (!session) return;
    await emit(ctx, {
      type: "MFA_BACKUP_CODES_REGENERATED",
      actorType: "USER",
      actorUserId: session.user.id,
      targetType: "USER",
      targetId: session.user.id,
    });
  }

  /**
   * Whether a new session is a login. Rotations are not: enrolling, disabling
   * and changing a password all replace the session of a signed-in user. Nor is
   * the interim session of a password sign-in that still owes a second factor,
   * which the twoFactor plugin deletes straight away.
   */
  async function isLoginSession(
    session: HookSession,
    ctx: HookContext | null,
  ): Promise<boolean> {
    if (ctx?.context.session) return false;
    if (ctx?.path === "/sign-in/email") {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { twoFactorEnabled: true },
      });
      if (user?.twoFactorEnabled) return false;
    }
    return true;
  }

  return {
    isLoginSession,

    /** `hooks.after`: every endpoint, success or failure. */
    async afterEndpoint(ctx: HookContext & ChallengeContext) {
      try {
        switch (ctx.path) {
          case "/two-factor/verify-totp":
          case "/two-factor/verify-backup-code":
            return await afterSecondFactorVerify(ctx, ctx.path);
          case "/two-factor/generate-backup-codes":
            if (isAPIError(ctx.context.returned)) return;
            return await afterGenerateBackupCodes(ctx);
          case "/sign-in/email":
            return await afterSignInEmail(ctx);
          case "/request-password-reset":
            return await afterRequestPasswordReset(ctx);
          case "/change-password":
            if (isAPIError(ctx.context.returned)) return;
            return await afterChangePassword(ctx);
          case "/revoke-sessions":
            if (isAPIError(ctx.context.returned)) return;
            return await afterRevokeSessions(ctx, "all");
          case "/revoke-other-sessions":
            if (isAPIError(ctx.context.returned)) return;
            return await afterRevokeSessions(ctx, "others");
        }
      } catch {
        ctx.context.logger.error("Failed to prepare audit event", {
          path: ctx.path,
        });
      }
    },

    /** After a sign-in swapped an imported bcrypt hash for scrypt. */
    async passwordRehashed(ctx: HookContext, userId: string) {
      await emit(ctx, {
        type: "PASSWORD_REHASHED",
        actorType: "USER",
        actorUserId: userId,
        targetType: "USER",
        targetId: userId,
      });
    },

    /** `databaseHooks.session.create.after`: every login path. */
    async sessionCreated(session: HookSession, ctx: HookContext | null) {
      await emit(ctx, {
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: session.userId,
        targetType: "USER",
        targetId: session.userId,
        ip: auditIp(session.ipAddress),
        userAgent: session.userAgent,
        metadata: { method: LOGIN_METHODS[ctx?.path ?? ""] ?? "other" },
      });
    },

    /** `databaseHooks.session.delete.after`: sign-out and single revocation. */
    async sessionDeleted(session: HookSession, ctx: HookContext | null) {
      const type =
        ctx?.path === "/sign-out"
          ? "LOGOUT"
          : ctx?.path === "/revoke-session"
            ? "SESSION_REVOKED"
            : null;
      if (!type) return;
      await emit(ctx, {
        type,
        actorType: "USER",
        actorUserId: session.userId,
        targetType: "SESSION",
        targetId: session.id,
      });
    },

    /**
     * `databaseHooks.user.update.after`. The twoFactor plugin updates the user
     * only on the enroll and disable transitions.
     */
    async userUpdated(user: HookUser, ctx: HookContext | null) {
      const type =
        ctx?.path === "/two-factor/verify-totp" &&
        user.twoFactorEnabled === true
          ? "MFA_ENROLLED"
          : ctx?.path === "/two-factor/disable" &&
              user.twoFactorEnabled === false
            ? "MFA_DISABLED"
            : null;
      if (!type) return;
      await emit(ctx, {
        type,
        actorType: "USER",
        actorUserId: user.id,
        targetType: "USER",
        targetId: user.id,
      });
    },

    /** `databaseHooks.user.create.after`. */
    async userCreated(user: HookUser, ctx: HookContext | null) {
      const admin = ctx?.context.session;
      const [source, actor] =
        ctx?.path === "/sign-up/email"
          ? ([
              "self_signup",
              { actorType: "USER", actorUserId: user.id },
            ] as const)
          : admin
            ? ([
                "admin",
                { actorType: "USER", actorUserId: admin.user.id },
              ] as const)
            : (["system", { actorType: "SYSTEM" }] as const);
      await emit(ctx, {
        type: "USER_CREATED",
        ...actor,
        targetType: "USER",
        targetId: user.id,
        metadata: { source },
      });
    },

    /** `emailVerification.afterEmailVerification`. */
    async emailVerified(user: HookUser, request?: Request) {
      await emit(
        null,
        {
          type: "EMAIL_VERIFIED",
          actorType: "USER",
          actorUserId: user.id,
          targetType: "USER",
          targetId: user.id,
        },
        request?.headers,
      );
    },

    /** `emailAndPassword.onPasswordReset`. */
    async passwordReset({ user }: { user: HookUser }, request?: Request) {
      await emit(
        null,
        {
          type: "PASSWORD_RESET",
          actorType: "USER",
          actorUserId: user.id,
          targetType: "USER",
          targetId: user.id,
        },
        request?.headers,
      );
    },
  };
}
