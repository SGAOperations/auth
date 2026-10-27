import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { passwordSchema } from "@/lib/auth/policy";
import { isResetTokenUsable } from "@/lib/auth/password-reset";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionInput,
  type TokenActionOutcome,
  type TokenActionResult,
} from "@/lib/token-links/handler";

// The two halves of the emailed reset link. The page only reads; the POST
// consumes, through Better Auth, which hashes the token and consumes it
// atomically, so it is single use. Unknown, expired and spent tokens are all
// `invalid` in both, so neither says why.

/**
 * The form's fields. The token handler applies only the shape, so the consumer
 * parses these again to enforce that the two passwords match.
 */
export const resetPasswordFields = z
  .object({ newPassword: passwordSchema, confirmPassword: z.string() })
  .refine((fields) => fields.newPassword === fields.confirmPassword);

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
  error: z.literal("fields").optional(),
});

export type ResetPasswordView =
  | { state: "ready"; token: string; fieldError: boolean }
  | { state: TokenActionResult };

/**
 * What the GET page shows. Read-only by construction: it looks the token up by
 * its stored hash and never writes, so a scanner pre-fetch consumes nothing.
 */
export async function loadResetPasswordView(
  searchParams: Record<string, string | string[] | undefined>,
  { db, now }: { db: Pick<PrismaClient, "verification">; now: Date },
): Promise<ResetPasswordView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  if (!parsed.success) return { state: "invalid" };
  const { token, result, error } = parsed.data;
  if (result) return { state: result };
  if (!token || !(await isResetTokenUsable(db, token, now))) {
    return { state: "invalid" };
  }
  return { state: "ready", token, fieldError: error === "fields" };
}

interface ResetPasswordAuth {
  api: {
    resetPassword(context: {
      body: { token: string; newPassword: string };
      headers: Headers;
    }): Promise<unknown>;
  };
}

const apiErrorBody = z.looseObject({ code: z.string() });

/**
 * The POST's `consume`. Every session is revoked by the reset, so there is no
 * sign-in afterwards; the done page points at the sign-in page.
 */
export function createResetPasswordConsumer({
  auth,
}: {
  auth: ResetPasswordAuth;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token, fields, request }) {
    const parsed = resetPasswordFields.safeParse(fields);
    if (!parsed.success) return { result: "retry", error: "fields" };

    try {
      await auth.api.resetPassword({
        body: { token, newPassword: parsed.data.newPassword },
        headers: request.headers,
      });
    } catch (error) {
      if (!isAPIError(error)) throw error;
      const code = apiErrorBody.safeParse(error.body);
      switch (code.success ? code.data.code : undefined) {
        case "INVALID_TOKEN":
          return { result: "invalid" };
        case "PASSWORD_TOO_SHORT":
        case "PASSWORD_TOO_LONG":
          return { result: "retry", error: "fields" };
        default:
          // Unexpected: the handler logs the error class and answers `error`.
          throw error;
      }
    }
    return { result: "done" };
  };
}
