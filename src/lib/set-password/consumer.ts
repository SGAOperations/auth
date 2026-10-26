import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { withAuditTransaction, audit } from "@/lib/audit";
import { passwordSchema } from "@/lib/auth/policy";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionInput,
  type TokenActionOutcome,
  type TokenActionResult,
} from "@/lib/token-links/handler";
import { hasPassword } from "@/lib/set-password/service";
import {
  consumeSetPasswordToken,
  peekSetPasswordToken,
  revokeSetPasswordTokens,
} from "@/lib/set-password/token";

// The two halves of the emailed set-password link. The page only reads; the
// POST consumes. Unknown, expired, spent and unusable tokens are all `invalid`
// in both, so neither says why.

/**
 * The form's fields. The token handler applies only the shape, so the consumer
 * parses these again to enforce that the two passwords match. Shared with the
 * client form of `/login` (AUTH-T25).
 */
export const setPasswordFields = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((fields) => fields.password === fields.confirmPassword);

const PAGE_RESULTS = [
  ...TOKEN_ACTION_RESULTS,
  "sent",
  "invalid-email",
] as const;

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(PAGE_RESULTS).optional(),
  error: z.literal("fields").optional(),
  signedIn: z.literal("1").optional(),
});

export type SetPasswordView =
  | { state: "ready"; token: string; email: string; fieldError: boolean }
  | {
      state: TokenActionResult | "sent" | "invalid-email";
      /** For `done`: the sign-in that followed the set produced a session. */
      signedIn: boolean;
    };

/**
 * What the GET page shows. Read-only by construction: it looks the token up
 * and never spends it, so a scanner pre-fetch consumes nothing.
 */
export async function loadSetPasswordView(
  searchParams: Record<string, string | string[] | undefined>,
  { prisma, now }: { prisma: PrismaClient; now: Date },
): Promise<SetPasswordView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  const invalid = { state: "invalid", signedIn: false } as const;
  if (!parsed.success) return invalid;
  const { token, result, error, signedIn } = parsed.data;
  if (result) return { state: result, signedIn: signedIn === "1" };
  if (!token) return invalid;

  const peeked = await peekSetPasswordToken(prisma, token, now);
  if (!peeked) return invalid;
  const user = await prisma.user.findUnique({
    where: { id: peeked.userId },
    select: { email: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return invalid;
  if (await hasPassword(prisma, peeked.userId)) return invalid;
  return {
    state: "ready",
    token,
    email: user.email,
    fieldError: error === "fields",
  };
}

const signInResult = z.looseObject({ token: z.string().min(1) });

interface SetPasswordAuth {
  $context: Promise<{
    password: { hash(password: string): Promise<string> };
  }>;
  api: {
    signInEmail(context: {
      body: { email: string; password: string };
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: unknown }>;
  };
}

/**
 * The POST's `consume`. The token, the credential, the verified email and the
 * audit row change in one transaction, so a failure leaves the link usable.
 */
export function createSetPasswordConsumer({
  prisma,
  auth,
  now,
}: {
  prisma: PrismaClient;
  auth: SetPasswordAuth;
  now: () => Date;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token, fields, request }) {
    const parsed = setPasswordFields.safeParse(fields);
    if (!parsed.success) return { result: "retry", error: "fields" };
    const { password } = parsed.data;

    // Before the transaction, so the scrypt hash never holds one open. It is
    // the hasher Better Auth signs in with.
    const hash = await (await auth.$context).password.hash(password);

    const at = now();
    const email = await withAuditTransaction(prisma, async (tx) => {
      const userId = await consumeSetPasswordToken(tx, token, at);
      if (userId === null) return null;

      // The token is spent either way. A deactivated user, or one who has
      // set a password since the link was sent, gets nothing.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true, status: true },
      });
      if (!user || user.status !== "ACTIVE") return null;
      if (await hasPassword(tx, userId)) return null;

      const credential = await tx.account.findFirst({
        where: { userId, providerId: "credential" },
        select: { id: true },
      });
      if (credential) {
        // An imported account with a null password. The condition is the race
        // guard against a concurrent set.
        const { count } = await tx.account.updateMany({
          where: { id: credential.id, password: null },
          data: { password: hash },
        });
        if (count !== 1) return null;
      } else {
        await tx.account.create({
          data: {
            providerId: "credential",
            accountId: userId,
            userId,
            password: hash,
          },
        });
      }

      // Holding the link proves the mailbox.
      await tx.user.update({
        where: { id: userId },
        data: { emailVerified: true, passwordChangedAt: at },
      });
      await revokeSetPasswordTokens(tx, userId);
      await audit(
        {
          type: "PASSWORD_SET",
          actorType: "USER",
          actorUserId: userId,
          targetType: "USER",
          targetId: userId,
        },
        { headers: request.headers },
      );
      return user.email;
    });
    if (email === null) return { result: "invalid" };

    // Through Better Auth, so the deactivation check, `lastLoginAt` and
    // `LOGIN_SUCCESS` all run. The password is set whatever happens here, so a
    // refusal (a lockout, a second factor) is never surfaced.
    try {
      const { headers, response } = await auth.api.signInEmail({
        body: { email, password },
        headers: request.headers,
        returnHeaders: true,
      });
      if (signInResult.safeParse(response).success) {
        return {
          result: "done",
          headers,
          redirectTo: "/set-password?result=done&signedIn=1",
        };
      }
    } catch (error) {
      if (!isAPIError(error)) throw error;
    }
    return { result: "done", redirectTo: "/set-password?result=done" };
  };
}
