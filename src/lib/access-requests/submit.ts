import "server-only";
import { listSubmitterPositionKeys } from "@/lib/access-submitters";
import { buildAccessRequestCopyString } from "@/lib/access-requests/copy-string";
import { parseAccessCommandText } from "@/lib/access-requests/input";
import type { AccessSubmitOutcome } from "@/lib/access-requests/replies";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { audit, withAuditTransaction } from "@/lib/audit";
import { canSubmitAccessRequest } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { displayName } from "@/lib/user-display";

// The `/access` slash command's service (#342). The actor is only the Slack
// user the verified request names, resolved through the SlackIdentity link;
// nothing in `text` can name another user.

type Db = PrismaClient | Prisma.TransactionClient;

export interface SubmitAccessRequestInput {
  slackTeamId: string;
  slackUserId: string;
  text: string;
}

/**
 * Resolves the Slack user, authorizes them, validates the text, and records the
 * request with its audit event in one transaction. A refusal returns its
 * outcome and writes nothing. Any other failure propagates.
 */
export async function submitAccessRequest(
  { slackTeamId, slackUserId, text }: SubmitAccessRequestInput,
  { db = prisma }: { db?: PrismaClient } = {},
): Promise<AccessSubmitOutcome> {
  const identity = await db.slackIdentity.findUnique({
    where: { slackTeamId_slackUserId: { slackTeamId, slackUserId } },
    select: {
      user: {
        select: {
          id: true,
          isAdmin: true,
          isPrimaryAdmin: true,
          status: true,
          name: true,
          preferredName: true,
        },
      },
    },
  });
  if (!identity) return { status: "not_linked" };
  const { user } = identity;

  const held = await heldPositions(db, user.id);
  const submitterKeys = await listSubmitterPositionKeys({ db });

  const decision = canSubmitAccessRequest(
    user,
    held.map(({ key }) => key),
    submitterKeys,
  );
  if (!decision.allowed) {
    return decision.reason === "ACTOR_INACTIVE"
      ? { status: "inactive" }
      : { status: "not_submitter" };
  }

  const parsed = parseAccessCommandText(text);
  if (!parsed.ok) return { status: "invalid", error: parsed.error };

  // Deterministic: the allowed held position with the lowest key.
  const allowed = new Set(submitterKeys);
  const position = held
    .filter(({ key }) => allowed.has(key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];

  const request = await withAuditTransaction(db, async (tx) => {
    const created = await tx.accessRequest.create({
      data: {
        requesterId: user.id,
        positionKey: position.key,
        positionName: position.name,
        product: parsed.product,
        access: parsed.access,
      },
    });
    await audit({
      type: "ACCESS_REQUEST_SUBMITTED",
      actorType: "USER",
      actorUserId: user.id,
      targetType: "USER",
      targetId: user.id,
      metadata: { accessRequestId: created.id, positionKey: position.key },
    });
    return created;
  });

  return {
    status: "submitted",
    requestId: request.id,
    copy: buildAccessRequestCopyString({
      requesterName: displayName(user),
      positionName: request.positionName,
      product: request.product,
      access: request.access,
      createdAt: request.createdAt,
    }),
  };
}

async function heldPositions(db: Db, userId: string) {
  const rows = await db.userPosition.findMany({
    where: { userId, position: { deletedAt: null } },
    select: { position: { select: { key: true, name: true } } },
  });
  return rows.map(({ position }) => position);
}
