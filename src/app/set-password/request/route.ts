import { after } from "next/server";
import { logger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createSetPasswordRequestHandler } from "@/lib/set-password/request-handler";
import { setPasswordService } from "@/lib/set-password/server";

export const runtime = "nodejs";

// The expired-link page's "Email me a new link" form. POST only: there is no
// GET export. The audit row is written by the service.
export const POST = createSetPasswordRequestHandler({
  mode: "form",
  service: setPasswordService,
  limit: (ids) => checkRateLimit("setPasswordRequest", ids),
  defer: after,
  log: logger,
});
