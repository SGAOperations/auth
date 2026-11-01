import { APIError } from "better-auth/api";
import { z } from "zod";
import { profileInputSchema } from "@/lib/account/profile";
import { AUTH_ERROR_CODES } from "@/lib/auth/policy";

// The server-side display-name rule for the Better Auth endpoints that take a
// name (black-team BT17). It is the account form's rule, so a name the profile
// page would refuse cannot arrive through `/sign-up/email` or `/update-user`
// either, and every email template can greet it.

export const NAME_CHECKED_PATHS: readonly string[] = [
  "/sign-up/email",
  "/update-user",
];

const displayName = profileInputSchema.shape.name;
const nameBody = z.looseObject({ name: z.string() });

/**
 * The body with its name trimmed, for a hook to hand on, or `undefined` when
 * there is no string name to check: a missing or non-string name is left to
 * the endpoint's own validation. Throws a 400 `INVALID_NAME` for a name that
 * breaks the rule.
 */
export function checkDisplayName(
  path: string | undefined,
  body: unknown,
): Record<string, unknown> | undefined {
  if (!path || !NAME_CHECKED_PATHS.includes(path)) return undefined;
  const parsed = nameBody.safeParse(body);
  if (!parsed.success) return undefined;
  const name = displayName.safeParse(parsed.data.name);
  if (!name.success) {
    throw APIError.from("BAD_REQUEST", AUTH_ERROR_CODES.INVALID_NAME);
  }
  return { ...parsed.data, name: name.data };
}
