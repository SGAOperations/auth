import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { requireFreshAuth } from "@/lib/auth/server";
import { mailer } from "@/lib/email/server";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { setPasswordService } from "@/lib/set-password/server";
import { createUserImportHandlers } from "@/lib/user-import/handlers";
import { createInviteSender } from "@/lib/user-import/invite-sender";

// The live wiring, kept here so that a rename in one of the modules behind it
// touches this file only. The admin guard and the rate limiter are not wired
// here: `@/lib/admin-api` owns both.
const sendInvite = createInviteSender({
  prisma,
  issueAdminInvite: (db, input) =>
    setPasswordService.issueAdminInvite(db, input),
  mailer,
  log: logger,
  now: () => new Date(),
});

export const liveUserImportHandlers = createUserImportHandlers({
  prisma,
  requireFreshAuth: async (headers) => {
    const result = await requireFreshAuth(headers);
    return result.ok ? null : result.response;
  },
  sendInvite,
  sleep: (ms) => sleep(ms),
});
