import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  isEmailAllowed,
  type SignupAllowlist,
} from "@/lib/auth/signup-allowlist";

export function signupAllowlist(list: SignupAllowlist): BetterAuthPlugin {
  return {
    id: "sgauth-signup-allowlist",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            if (typeof email === "string" && !isEmailAllowed(list, email)) {
              throw new APIError("FORBIDDEN", {
                message: "Sign-up is invite-only on this environment.",
              });
            }
          }),
        },
      ],
    },
  };
}
