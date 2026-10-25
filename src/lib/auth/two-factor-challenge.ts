import "server-only";

// The part of a Better Auth endpoint context this reads. Declared here so it
// does not depend on the internal context types, and so both a before hook and
// an after hook can pass theirs.
export interface ChallengeContext {
  getSignedCookie: (
    name: string,
    secret: string,
  ) => Promise<string | false | null | undefined>;
  context: {
    secret: string;
    createAuthCookie: (name: string) => { name: string };
    internalAdapter: {
      findVerificationValue: (
        identifier: string,
      ) => Promise<{ value: string } | null | undefined>;
    };
  };
}

// The plugin's own cookie name; it is not exported.
const TWO_FACTOR_COOKIE_NAME = "two_factor";

/**
 * The user of the pending sign-in challenge, from the signed `two_factor`
 * cookie. Mirrors `verifyTwoFactor` in Better Auth's plugin. Returns null on
 * any miss, and the endpoint then rejects the request itself. A signed-in
 * caller has no challenge: use the session user instead.
 */
export async function resolveChallengeUserId(
  ctx: ChallengeContext,
): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const challenge =
    await ctx.context.internalAdapter.findVerificationValue(identifier);
  return challenge?.value ?? null;
}
