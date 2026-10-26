import { auth } from "@/lib/auth/config";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit/server";
import {
  createSetPasswordConsumer,
  setPasswordFields,
} from "@/lib/set-password/consumer";
import { createTokenActionHandler } from "@/lib/token-links/handler";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
// Holding the token is the authority, so the request is anonymous; the handler
// enforces same-origin and the tokenLink IP limit. PASSWORD_SET is written by
// the consumer, in the transaction that sets the password.
export const POST = createTokenActionHandler({
  action: "set-password",
  fields: setPasswordFields,
  consume: createSetPasswordConsumer({
    prisma,
    auth,
    now: () => new Date(),
  }),
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
});
