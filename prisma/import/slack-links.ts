import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";
import { parseAuditEvent } from "../../src/lib/audit-catalog.js";
import { UsageError } from "../seed/sync-env.js";
import { ImportInputError } from "./chambers.js";

// The one-time import of Chambers' Slack links (#315), behind
// scripts/import-slack-links.ts. Like chambers.ts it takes its client as an
// argument and never reads process.env (ENGINEERING §2). The source is written
// by Chambers' scripts/sgauth/export-slack-links.mjs: SGAuth user ids and Slack
// user ids, no addresses. See docs/runbooks/slack-link-import.md.

const slackTeamId = z.string().regex(/^T[A-Z0-9]{2,20}$/);

const sourceSchema = z
  .array(
    z.strictObject({
      sgauthUserId: z.uuid(),
      slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/),
    }),
  )
  .max(10_000);

export type SlackLinkRow = z.output<typeof sourceSchema>[number];

export interface SlackLinkImportArgs {
  source: string;
  team: string;
  apply: boolean;
}

export function parseSlackLinkImportArgs(argv: string[]): SlackLinkImportArgs {
  let source: string | undefined;
  let team: string | undefined;
  let apply: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") source = argv[++i];
    else if (arg === "--team") team = argv[++i];
    else if (arg === "--apply" || arg === "--dry-run") {
      if (apply !== undefined) {
        throw new UsageError("Pass one of --dry-run or --apply, once.");
      }
      apply = arg === "--apply";
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (!source) throw new UsageError("--source is required.");
  if (!team || !slackTeamId.safeParse(team).success) {
    throw new UsageError("--team must be a Slack workspace id (T...).");
  }
  if (apply === undefined) {
    throw new UsageError("Pass --dry-run or --apply.");
  }
  return { source, team, apply };
}

/**
 * Parses the export. A user or a Slack account listed twice is an input error,
 * not something to pick between: Chambers' export refuses to write one.
 */
export function validateSlackLinkSource(raw: unknown): SlackLinkRow[] {
  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImportInputError(
      `The source is not a list of { sgauthUserId, slackUserId }: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.path.join(".") || "$")
        .join(", ")}`,
    );
  }
  const users = new Set<string>();
  const slack = new Set<string>();
  parsed.data.forEach((row, index) => {
    if (users.has(row.sgauthUserId) || slack.has(row.slackUserId)) {
      throw new ImportInputError(
        `Row ${index + 1} repeats a user or a Slack account listed earlier.`,
      );
    }
    users.add(row.sgauthUserId);
    slack.add(row.slackUserId);
  });
  return parsed.data;
}

export async function loadSlackLinkSource(
  path: string,
): Promise<{ rows: SlackLinkRow[]; sha256: string }> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportInputError("The source is not valid JSON.");
  }
  return {
    rows: validateSlackLinkSource(raw),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

export interface SlackLinkState {
  /** status of every listed user that exists */
  users: Map<string, "ACTIVE" | "DEACTIVATED" | "DELETED">;
  /** the Slack account each listed user has linked already */
  byUser: Map<string, { slackTeamId: string; slackUserId: string }>;
  /** the user each listed Slack account is linked to already */
  bySlack: Map<string, string>;
}

export type SlackLinkOutcome =
  | "link"
  | "unchanged"
  | "conflict"
  | "missing_user";

export interface SlackLinkPlan {
  rows: { row: SlackLinkRow; outcome: SlackLinkOutcome }[];
  counts: Record<SlackLinkOutcome, number>;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function readSlackLinkState(
  db: Db,
  team: string,
  rows: SlackLinkRow[],
): Promise<SlackLinkState> {
  const userIds = rows.map((row) => row.sgauthUserId);
  const [users, identities] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, status: true },
    }),
    db.slackIdentity.findMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          {
            slackTeamId: team,
            slackUserId: { in: rows.map((row) => row.slackUserId) },
          },
        ],
      },
      select: { userId: true, slackTeamId: true, slackUserId: true },
    }),
  ]);
  return {
    users: new Map(users.map((user) => [user.id, user.status])),
    byUser: new Map(
      identities.map((identity) => [
        identity.userId,
        {
          slackTeamId: identity.slackTeamId,
          slackUserId: identity.slackUserId,
        },
      ]),
    ),
    bySlack: new Map(
      identities
        .filter((identity) => identity.slackTeamId === team)
        .map((identity) => [identity.slackUserId, identity.userId]),
    ),
  };
}

/**
 * Pure. A row links when the user exists and is not deleted, and neither side
 * is linked yet. A link already in SGAuth always wins: someone who linked
 * themselves since the export is never overwritten, only reported.
 */
export function planSlackLinkImport(
  team: string,
  rows: SlackLinkRow[],
  state: SlackLinkState,
): SlackLinkPlan {
  const counts: Record<SlackLinkOutcome, number> = {
    link: 0,
    unchanged: 0,
    conflict: 0,
    missing_user: 0,
  };
  const planned = rows.map((row) => {
    const status = state.users.get(row.sgauthUserId);
    const mine = state.byUser.get(row.sgauthUserId);
    const holder = state.bySlack.get(row.slackUserId);
    let outcome: SlackLinkOutcome;
    if (status === undefined || status === "DELETED") outcome = "missing_user";
    else if (
      mine?.slackTeamId === team &&
      mine.slackUserId === row.slackUserId
    ) {
      outcome = "unchanged";
    } else if (mine || holder) outcome = "conflict";
    else outcome = "link";
    counts[outcome] += 1;
    return { row, outcome };
  });
  return { rows: planned, counts };
}

export function formatSlackLinkSummary(plan: SlackLinkPlan): string {
  const { counts } = plan;
  return [
    `  link:          ${counts.link}`,
    `  unchanged:     ${counts.unchanged}`,
    `  conflict:      ${counts.conflict} (left as SGAuth has them)`,
    `  missing user:  ${counts.missing_user} (unknown or deleted in SGAuth)`,
  ].join("\n");
}

/**
 * Writes the plan in one transaction, re-planned from fresh reads, with one
 * BULK_IMPORT event. A link made by someone between the read and the write
 * fails the unique index and rolls everything back; a re-run converges.
 */
export async function applySlackLinkImport(
  db: PrismaClient,
  input: { team: string; rows: SlackLinkRow[]; sourceSha256: string },
): Promise<SlackLinkPlan> {
  return db.$transaction(async (tx) => {
    const plan = planSlackLinkImport(
      input.team,
      input.rows,
      await readSlackLinkState(tx, input.team, input.rows),
    );
    const linking = plan.rows.filter((entry) => entry.outcome === "link");
    if (linking.length > 0) {
      await tx.slackIdentity.createMany({
        data: linking.map(({ row }) => ({
          userId: row.sgauthUserId,
          slackTeamId: input.team,
          slackUserId: row.slackUserId,
          linkedVia: "IMPORT" as const,
        })),
      });
    }
    await tx.auditEvent.create({
      data: parseAuditEvent({
        type: "BULK_IMPORT",
        actorType: "SYSTEM",
        metadata: {
          source: "slack_links",
          sourceSha256: input.sourceSha256,
          slackTeamId: input.team,
          linked: plan.counts.link,
          unchanged: plan.counts.unchanged,
          conflicts: plan.counts.conflict,
          missingUsers: plan.counts.missing_user,
        },
      }),
    });
    return plan;
  });
}

/** The report written next to the run: ids and outcomes, no addresses. */
export function buildSlackLinkReport(
  plan: SlackLinkPlan,
  meta: {
    generatedAt: Date;
    target: string;
    sourceSha256: string;
    dryRun: boolean;
  },
) {
  return {
    ...meta,
    generatedAt: meta.generatedAt.toISOString(),
    counts: plan.counts,
    notLinked: plan.rows
      .filter(
        (entry) =>
          entry.outcome === "conflict" || entry.outcome === "missing_user",
      )
      .map(({ row, outcome }) => ({ sgauthUserId: row.sgauthUserId, outcome })),
  };
}
