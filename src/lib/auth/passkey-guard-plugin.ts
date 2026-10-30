import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_ERROR_CODES,
  hasUserVerification,
  passkeyNameSchema,
} from "@/lib/auth/passkey-policy";

const nameBody = z.looseObject({ name: z.unknown().optional() });
const assertionBody = z.looseObject({
  response: z.looseObject({
    response: z.looseObject({ authenticatorData: z.string() }),
  }),
});

const NAME_PATHS = ["/passkey/verify-registration", "/passkey/update-passkey"];

/**
 * The rules the stock passkey plugin lacks: a cap on how many a user holds, a
 * bounded name, and a required user-verification flag on every sign-in.
 *
 * Re-auth is not enforced here. The sgauth-reauth plugin gates the enrollment
 * and removal paths through FRESH_AUTH_AUTH_PATHS, and is registered before this
 * plugin so its prompt answers first.
 */
export function passkeyGuard(prisma: PrismaClient) {
  return {
    id: "sgauth-passkey-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/passkey/generate-register-options",
          handler: createAuthMiddleware(async (ctx) => {
            // No session: the endpoint answers 401 itself.
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const held = await prisma.passkey.count({
              where: { userId: session.user.id },
            });
            if (held >= MAX_PASSKEYS_PER_USER) {
              throw APIError.from(
                "BAD_REQUEST",
                PASSKEY_ERROR_CODES.PASSKEY_LIMIT_REACHED,
              );
            }
          }),
        },
        {
          matcher: (ctx) => NAME_PATHS.includes(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const body = nameBody.safeParse(ctx.body);
            // A body the endpoint's own schema rejects is answered by it.
            if (!body.success || body.data.name === undefined) return;
            const name = passkeyNameSchema.safeParse(body.data.name);
            if (!name.success) {
              throw APIError.from(
                "BAD_REQUEST",
                PASSKEY_ERROR_CODES.INVALID_PASSKEY_NAME,
              );
            }
            return { context: { body: { ...body.data, name: name.data } } };
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-authentication",
          handler: createAuthMiddleware(async (ctx) => {
            const body = assertionBody.safeParse(ctx.body);
            if (
              !body.success ||
              !hasUserVerification(
                body.data.response.response.authenticatorData,
              )
            ) {
              throw APIError.from(
                "BAD_REQUEST",
                PASSKEY_ERROR_CODES.PASSKEY_USER_VERIFICATION_REQUIRED,
              );
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
