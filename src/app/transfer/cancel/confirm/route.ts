import { withAuditTransaction } from "@/lib/audit";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { consumeCancelToken } from "@/lib/jobs/pa-transfer-actions";
import { sendNotice } from "@/lib/jobs/pa-transfer-http";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createTokenActionHandler } from "@/lib/token-links/handler";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
// Holding the token is the Primary Admin's authority, so the request is
// anonymous; the handler enforces same-origin and the tokenLink IP limit. The
// token, the status and the audit row change in one transaction, and the mail
// goes out after it commits.
export const POST = createTokenActionHandler({
  action: "pa-transfer-cancel",
  consume: async ({ token }) => {
    const result = await withAuditTransaction(prisma, (tx) =>
      consumeCancelToken(tx, token, new Date()),
    );
    if (!result) return { result: "invalid" };
    await sendNotice(result.notice);
    return { result: "done" };
  },
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
