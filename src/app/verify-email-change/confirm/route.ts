import { toAuthSettings } from "@/lib/auth/settings";
import { emailChangeService } from "@/lib/email-change/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createTokenActionHandler } from "@/lib/token-links/handler";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
// Holding the token is the authority, so the request is anonymous; the handler
// enforces same-origin and the tokenLink IP limit. EMAIL_CHANGED is written
// inside confirmEmailChange's transaction, so the swap and its audit row commit
// together.
export const POST = createTokenActionHandler({
  action: "email-change",
  consume: async ({ token }) => {
    const outcome = await emailChangeService.confirmEmailChange(token);
    switch (outcome.state) {
      case "done":
        return { result: "done" };
      case "used":
        return { result: "used" };
      case "invalid":
        return { result: "invalid" };
      // Back to the page, which re-reads the token and says which it is.
      case "expired":
      case "unavailable":
        return { result: "retry", error: outcome.state };
    }
  },
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
