import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  channelMappingInputSchema,
  productSlugForRoleKey,
} from "./channel-mapping-input";

// Which Slack channels the holders of a product role join (#330). A mapping is
// stored against the position row, not its key: a retired key can be reused, and
// a mapping by key would hand the old role's private channels to the new one.
//
// These helpers do not authorize. The caller checks the admin, enforces Origin
// and writes the AuditEvent in the same `db` transaction it passes in.

type Db = PrismaClient | Prisma.TransactionClient;

export interface ChannelMappingView {
  id: string;
  positionId: string;
  roleKey: string;
  slackTeamId: string;
  slackChannelId: string;
  createdById: string;
  createdAt: Date;
}

export type AddChannelMappingResult =
  /** `field` is the first input key that failed validation. Nothing was read. */
  | { status: "invalid"; field: string }
  /** No active position has this key. A retired key is unknown. */
  | { status: "unknown_role" }
  /** The key does not start with any product's slug. */
  | { status: "not_product_role" }
  | { status: "exists" }
  | { status: "created"; mapping: ChannelMappingView };

const mappingSelect = {
  id: true,
  positionId: true,
  slackTeamId: true,
  slackChannelId: true,
  createdById: true,
  createdAt: true,
  position: { select: { key: true } },
} satisfies Prisma.SlackChannelMappingSelect;

type MappingRow = Prisma.SlackChannelMappingGetPayload<{
  select: typeof mappingSelect;
}>;

function toView(row: MappingRow): ChannelMappingView {
  return {
    id: row.id,
    positionId: row.positionId,
    roleKey: row.position.key,
    slackTeamId: row.slackTeamId,
    slackChannelId: row.slackChannelId,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

/**
 * Maps a product role to a Slack channel. `createdById` is the session user,
 * passed in by the caller; the rest of `input` is untrusted and validated.
 *
 * When `db` is an interactive transaction, the `exists` outcome (a P2002) has
 * aborted the Postgres transaction: it is unusable afterwards, so the caller
 * must return or roll back rather than keep writing on it.
 */
export async function addChannelMapping(
  db: Db,
  {
    createdById,
    ...untrusted
  }: { createdById: string } & Record<string, unknown>,
): Promise<AddChannelMappingResult> {
  const parsed = channelMappingInputSchema.safeParse(untrusted);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.path[0];
    return { status: "invalid", field: typeof key === "string" ? key : "" };
  }
  const { roleKey, slackTeamId, slackChannelId } = parsed.data;

  const position = await db.position.findFirst({
    where: { key: roleKey, deletedAt: null },
    select: { id: true },
  });
  if (!position) return { status: "unknown_role" };

  // Inactive products count: a role does not stop being a product role when its
  // product is hidden.
  const products = await db.product.findMany({ select: { slug: true } });
  const slug = productSlugForRoleKey(
    roleKey,
    products.map((product) => product.slug),
  );
  if (slug === null) return { status: "not_product_role" };

  try {
    const row = await db.slackChannelMapping.create({
      data: {
        positionId: position.id,
        slackTeamId,
        slackChannelId,
        createdById,
      },
      select: mappingSelect,
    });
    return { status: "created", mapping: toView(row) };
  } catch (err) {
    // The unique index decides, so a concurrent add cannot slip through.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { status: "exists" };
    }
    throw err;
  }
}

/** Removes a mapping and returns it, or null when no row has that id. */
export async function removeChannelMapping(
  db: Db,
  id: string,
): Promise<ChannelMappingView | null> {
  const existing = await db.slackChannelMapping.findUnique({
    where: { id },
    select: mappingSelect,
  });
  if (!existing) return null;
  const { count } = await db.slackChannelMapping.deleteMany({ where: { id } });
  return count === 1 ? toView(existing) : null;
}

/** Every mapping on an active position, by role key and then channel. */
export async function listChannelMappings(
  db: Db,
): Promise<ChannelMappingView[]> {
  const rows = await db.slackChannelMapping.findMany({
    where: { position: { deletedAt: null } },
    select: mappingSelect,
    orderBy: [{ position: { key: "asc" } }, { slackChannelId: "asc" }],
  });
  return rows.map(toView);
}

/** The channels mapped to these positions, active positions only. */
export async function channelsForPositions(
  db: Db,
  positionIds: string[],
): Promise<
  { positionId: string; slackTeamId: string; slackChannelId: string }[]
> {
  if (positionIds.length === 0) return [];
  return db.slackChannelMapping.findMany({
    where: { positionId: { in: positionIds }, position: { deletedAt: null } },
    select: { positionId: true, slackTeamId: true, slackChannelId: true },
    orderBy: [{ positionId: "asc" }, { slackChannelId: "asc" }],
  });
}
