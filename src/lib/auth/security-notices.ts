import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { HookContext, HookUser } from "@/lib/auth/audit-hooks";
import type { Mailer } from "@/lib/email/mailer";
import type { SecurityNoticeEvent } from "@/lib/email/templates";

// The security notice for a new or removed sign-in factor (black-team BT12):
// the owner hears about a passkey or authenticator an attacker adds, which is
// what makes a stolen password or a pre-hijacked account stick. The same
// transitions the audit adapters record, mailed after the response.

const registeredPasskey = z.looseObject({ userId: z.string().min(1) });

export function createSecurityNoticeHooks({
  prisma,
  mailer,
  now = () => new Date(),
}: {
  prisma: Pick<PrismaClient, "user">;
  mailer: Pick<Mailer, "sendEmail">;
  now?: () => Date;
}) {
  // Never fails the request: the change has already committed. The logger gets
  // the event only, as the error could carry the address.
  async function send(
    ctx: HookContext | null,
    userId: string,
    event: SecurityNoticeEvent,
  ) {
    const task = (async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, name: true, preferredName: true },
        });
        if (!user) return;
        await mailer.sendEmail({
          to: user.email,
          template: "security-notice",
          data: {
            name: user.preferredName ?? user.name,
            event,
            occurredAt: now(),
          },
        });
      } catch {
        const message = "Failed to send security notice";
        if (ctx) ctx.context.logger.error(message, { event });
        else console.error(message, { event });
      }
    })();
    const run = ctx?.context.runInBackgroundOrAwait;
    await (run ? run(task) : task);
  }

  return {
    /** `hooks.after`: passkey enrollment and removal. */
    async afterEndpoint(ctx: HookContext) {
      if (isAPIError(ctx.context.returned)) return;
      if (ctx.path === "/passkey/verify-registration") {
        // The endpoint returns the row it just wrote.
        const passkey = registeredPasskey.safeParse(ctx.context.returned);
        if (passkey.success) {
          await send(ctx, passkey.data.userId, "passkey-added");
        }
        return;
      }
      if (ctx.path === "/passkey/delete-passkey") {
        const userId = ctx.context.session?.user.id;
        if (userId) await send(ctx, userId, "passkey-removed");
      }
    },

    /**
     * `databaseHooks.user.update.after`. The twoFactor plugin updates the user
     * only on the enroll and disable transitions, the rule the MFA_ENROLLED and
     * MFA_DISABLED audit events use.
     */
    async userUpdated(user: HookUser, ctx: HookContext | null) {
      if (
        ctx?.path === "/two-factor/verify-totp" &&
        user.twoFactorEnabled === true
      ) {
        await send(ctx, user.id, "mfa-enabled");
      } else if (
        ctx?.path === "/two-factor/disable" &&
        user.twoFactorEnabled === false
      ) {
        await send(ctx, user.id, "mfa-disabled");
      }
    },
  };
}
