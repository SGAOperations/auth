import "server-only";
import { writeAuditEvent } from "@/lib/audit";
import { canUseProducts, type AuthzSubject } from "@/lib/authz";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// The leadership Slack-link mandate (#361): while SGAUTH_SLACK_MANDATE_ENABLED
// is on, a leadership holder without a linked Slack account (any SlackIdentity,
// however it was linked) is refused by the endpoints products get identity from.
// SGAuth's own pages never refuse.
// Must not import "@/lib/auth/server": the auth config imports this module.

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SlackMandateSurface = "session" | "token";

export const slackMandateEnabled = (): boolean =>
  env.SGAUTH_SLACK_MANDATE_ENABLED === "true";

/**
 * Whether the mandate blocks `user` from products. A blocked leader is by
 * definition unlinked, so there is nothing more to report. One query, none
 * while the mandate is off.
 */
export async function getOwnSlackMandate(
  user: AuthzSubject,
): Promise<{ blocked: boolean }> {
  if (!slackMandateEnabled()) return { blocked: false };
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      slackIdentity: { select: { id: true } },
      positions: {
        where: { position: { deletedAt: null, isLeadership: true } },
        select: { positionId: true },
        take: 1,
      },
    },
  });
  const decision = canUseProducts(
    user,
    {
      isLeadership: (row?.positions.length ?? 0) > 0,
      hasSlackIdentity: row?.slackIdentity != null,
    },
    { slackMandateEnabled: slackMandateEnabled() },
  );
  return {
    blocked: !decision.allowed && decision.reason === "SLACK_LINK_REQUIRED",
  };
}

/**
 * Audits a refusal, at most once per user per day plus once after each link:
 * a row is written only when the newest of the user's SLACK_MANDATE_BLOCKED and
 * SLACK_LINKED events in the last 24 hours is not a block. Best effort:
 * a failure is logged and never changes the refusal, and nothing here throws.
 * The actor is SYSTEM and the address is null, because the caller is a product
 * server rather than the user. Not transactional, so two concurrent first
 * blocks can both write.
 */
export async function recordSlackMandateBlock(
  userId: string,
  surface: SlackMandateSurface,
  now: Date = new Date(),
): Promise<void> {
  try {
    const newest = await prisma.auditEvent.findFirst({
      where: {
        type: { in: ["SLACK_MANDATE_BLOCKED", "SLACK_LINKED"] },
        targetType: "USER",
        targetId: userId,
        createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { type: true },
    });
    if (newest?.type === "SLACK_MANDATE_BLOCKED") return;
    await writeAuditEvent(prisma, {
      type: "SLACK_MANDATE_BLOCKED",
      actorType: "SYSTEM",
      targetType: "USER",
      targetId: userId,
      metadata: { surface },
      ip: null,
      userAgent: null,
    });
  } catch {
    logger.warn("slack_mandate_block_unaudited", { surface });
  }
}
