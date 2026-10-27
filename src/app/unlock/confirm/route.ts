import { audit } from "@/lib/audit";
import { toAuthSettings } from "@/lib/auth/settings";
import { createUnlockConsumer } from "@/lib/auth/unlock";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createTokenActionHandler } from "@/lib/token-links/handler";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
// Holding the token is the authority, so the request is anonymous; the handler
// enforces same-origin and the tokenLink IP limit.
export const POST = createTokenActionHandler({
  action: "account-unlock",
  consume: createUnlockConsumer({
    prisma,
    // Written in the unlock transaction, so the event and the unlock commit
    // together.
    onUnlocked: async (tx, userId) => {
      await audit(
        {
          type: "ACCOUNT_UNLOCKED",
          actorType: "USER",
          actorUserId: userId,
          targetType: "USER",
          targetId: userId,
          metadata: { method: "email_link" },
        },
        { db: tx },
      );
    },
  }),
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
