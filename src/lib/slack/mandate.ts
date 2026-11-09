import "server-only";
import { writeAuditEvent } from "@/lib/audit";
import { canUseProducts, type AuthzSubject } from "@/lib/authz";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// The leadership Slack-link mandate (#361): while SGAUTH_SLACK_MANDATE_ENABLED
// is on, a leadership holder who has not allowed Slack title updates is refused
// by the endpoints products get identity from. SGAuth's own pages never refuse.
// Must not import "@/lib/auth/server": the auth config imports this module.

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SlackMandateSurface = "session" | "token";

export const slackMandateEnabled = (): boolean =>
  env.SGAUTH_SLACK_MANDATE_ENABLED === "true";

/**
 * Whether the mandate blocks `user` from products, and whether they have a
 * Slack account linked (it decides the copy). One query, none while the
 * mandate is off.
 */
export async function getOwnSlackMandate(
  user: AuthzSubject,
): Promise<{ blocked: boolean; linked: boolean }> {
  // `linked` only matters when blocked, so a disabled mandate skips the query.
  if (!slackMandateEnabled()) return { blocked: false, linked: false };
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      slackIdentity: { select: { id: true } },
      slackUserToken: { select: { id: true } },
      positions: {
        where: { position: { deletedAt: null, isLeadership: true } },
        select: { positionId: true },
        take: 1,
      },
    },
  });
  const isLeadership = (row?.positions.length ?? 0) > 0;
  const hasSlackProfileAccess = row?.slackUserToken != null;
  const decision = canUseProducts(
    user,
    { isLeadership, hasSlackProfileAccess },
    { slackMandateEnabled: slackMandateEnabled() },
  );
  return {
    blocked: !decision.allowed && decision.reason === "SLACK_LINK_REQUIRED",
    linked: row?.slackIdentity != null,
  };
}

/**
 * Audits a refusal, at most once per user per day plus once after each grant:
 * a row is written only when the newest of the user's SLACK_MANDATE_BLOCKED and
 * SLACK_TOKEN_GRANTED events in the last 24 hours is not a block. Best effort:
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
        type: { in: ["SLACK_MANDATE_BLOCKED", "SLACK_TOKEN_GRANTED"] },
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
