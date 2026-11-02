import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { SlackLinkSource } from "@/generated/prisma/client";

// The Slack account each SGAuth user has proved is theirs (#313). Products ask
// SGAuth who a Slack user is instead of keeping their own Slack links.
//
// A link is made one of three ways: a product DMs a single-use link token to
// the Slack user who ran its command and that person confirms it signed in to
// SGAuth (SLACK_COMMAND); the person signs in with Slack from the account page
// (SLACK_OPENID, #314); or the one-time import of Chambers' links (IMPORT, #315).

/** A Slack workspace id. Enterprise Grid org ids (E…) are not workspaces. */
export const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{2,20}$/);
/** A Slack user id: U… for members, W… for Enterprise Grid members. */
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{2,20}$/);

/** Fifteen minutes, the lifetime of the DM'd link Chambers used before. */
export const SLACK_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/** The most ids one lookup may ask about, in each direction. */
export const SLACK_LOOKUP_MAX_IDS = 100;

type Db = PrismaClient | Prisma.TransactionClient;

/** Lower-case hex SHA-256: the only form of a link token that is ever stored. */
export function hashSlackLinkToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A fresh link token for a Slack user. Returns the raw token, for the url only. */
export async function issueSlackLinkToken(
  db: Db,
  input: { productId: string; slackTeamId: string; slackUserId: string },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SLACK_LINK_TOKEN_TTL_MS);
  // Expired and spent tokens for this Slack user are of no further use.
  await db.slackLinkToken.deleteMany({
    where: {
      slackTeamId: input.slackTeamId,
      slackUserId: input.slackUserId,
      OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }],
    },
  });
  await db.slackLinkToken.create({
    data: { ...input, tokenHash: hashSlackLinkToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export interface SlackLinkTokenView {
  slackTeamId: string;
  slackUserId: string;
  productId: string;
  productName: string;
}

/**
 * What an unused, unexpired token would link, or null. Reads only: the page
 * that shows it is a GET, and Slack's link unfurler fetches it too.
 */
export async function readSlackLinkToken(
  db: Db,
  raw: string,
  now: Date = new Date(),
): Promise<SlackLinkTokenView | null> {
  const row = await db.slackLinkToken.findUnique({
    where: { tokenHash: hashSlackLinkToken(raw) },
    select: {
      slackTeamId: true,
      slackUserId: true,
      expiresAt: true,
      usedAt: true,
      product: { select: { id: true, name: true, isActive: true } },
    },
  });
  if (!row || row.usedAt || row.expiresAt <= now || !row.product.isActive) {
    return null;
  }
  return {
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    productId: row.product.id,
    productName: row.product.name,
  };
}

/**
 * Marks the token used and returns what it links, or null for an unknown, used
 * or expired one. The conditional update is the single-use guard.
 */
export async function consumeSlackLinkToken(
  db: Db,
  raw: string,
  now: Date = new Date(),
): Promise<SlackLinkTokenView | null> {
  const view = await readSlackLinkToken(db, raw, now);
  if (!view) return null;
  const { count } = await db.slackLinkToken.updateMany({
    where: {
      tokenHash: hashSlackLinkToken(raw),
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  return count === 1 ? view : null;
}

export type LinkSlackResult =
  | {
      status: "linked";
      replaced: { slackTeamId: string; slackUserId: string } | null;
    }
  | { status: "unchanged" }
  /** The Slack account belongs to another SGAuth user. Nothing was written. */
  | { status: "taken" };

/**
 * Links a Slack account to a user, replacing the user's previous one. Refuses
 * a Slack account linked to someone else: moving it would let whoever holds a
 * link token take it over, so the other user has to unlink first.
 */
export async function linkSlackIdentity(
  db: Db,
  input: {
    userId: string;
    slackTeamId: string;
    slackUserId: string;
    linkedVia: SlackLinkSource;
    productId?: string | null;
  },
  now: Date = new Date(),
): Promise<LinkSlackResult> {
  const holder = await db.slackIdentity.findUnique({
    where: {
      slackTeamId_slackUserId: {
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
      },
    },
    select: { userId: true },
  });
  if (holder) {
    return holder.userId === input.userId
      ? { status: "unchanged" }
      : { status: "taken" };
  }

  const previous = await db.slackIdentity.findUnique({
    where: { userId: input.userId },
    select: { slackTeamId: true, slackUserId: true },
  });
  const data = {
    slackTeamId: input.slackTeamId,
    slackUserId: input.slackUserId,
    linkedVia: input.linkedVia,
    productId: input.productId ?? null,
    linkedAt: now,
  };
  try {
    await db.slackIdentity.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, ...data },
      update: data,
    });
  } catch (err) {
    // Another request linked the same Slack account between the read and here.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { status: "taken" };
    }
    throw err;
  }
  return { status: "linked", replaced: previous };
}

/** Removes the user's Slack link and returns it, or null when there was none. */
export async function unlinkSlackIdentity(
  db: Db,
  userId: string,
): Promise<{ slackTeamId: string; slackUserId: string } | null> {
  const existing = await db.slackIdentity.findUnique({
    where: { userId },
    select: { slackTeamId: true, slackUserId: true },
  });
  if (!existing) return null;
  const { count } = await db.slackIdentity.deleteMany({ where: { userId } });
  return count === 1 ? existing : null;
}

export interface SlackIdentityView {
  userId: string;
  slackTeamId: string;
  slackUserId: string;
}

/**
 * The links of active users in one workspace, matched by Slack id, by SGAuth id,
 * or both. A deactivated or deleted user is not linked as far as a product can
 * tell, so a product never acts for someone who may not sign in.
 */
export async function lookupSlackIdentities(
  db: Db,
  input: { slackTeamId: string; slackUserIds: string[]; userIds: string[] },
): Promise<SlackIdentityView[]> {
  if (input.slackUserIds.length === 0 && input.userIds.length === 0) return [];
  return db.slackIdentity.findMany({
    where: {
      slackTeamId: input.slackTeamId,
      user: { status: "ACTIVE" },
      OR: [
        ...(input.slackUserIds.length
          ? [{ slackUserId: { in: input.slackUserIds } }]
          : []),
        ...(input.userIds.length ? [{ userId: { in: input.userIds } }] : []),
      ],
    },
    select: { userId: true, slackTeamId: true, slackUserId: true },
    orderBy: { userId: "asc" },
  });
}
