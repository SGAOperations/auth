import "server-only";
import { createAdminUserHandlers } from "@/lib/admin/users/handlers";
import { clearAccountLock } from "@/lib/auth/lockout";
import { requireFreshAuth } from "@/lib/auth/server";
import { mailer } from "@/lib/email/server";
import { sendNotice } from "@/lib/jobs/pa-transfer-http";
import { prisma } from "@/lib/prisma";
import { setPasswordService } from "@/lib/set-password/server";

// The live wiring. The adapters sit here so that a rename in one of the
// modules behind them touches this file only. The admin guard and the rate
// limiter are not wired here: `@/lib/admin-api` owns both.
export const liveAdminUserHandlers = createAdminUserHandlers({
  prisma,
  requireFreshAuth: async (headers) => {
    const result = await requireFreshAuth(headers);
    return result.ok ? null : result.response;
  },
  clearAccountLock,
  issueAdminInvite: (db, input) =>
    setPasswordService.issueAdminInvite(db, input),
  mailer,
  sendTransferNotice: sendNotice,
  now: () => new Date(),
});
