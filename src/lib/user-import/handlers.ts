import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { apiError, apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import {
  audit,
  auditMany,
  auditRequestInfo,
  withAuditContext,
  withAuditTransaction,
  type AuditCall,
  type AuditEventType,
} from "@/lib/audit";
import { logger } from "@/lib/log";
import {
  applyImportPlan,
  ImportError,
  type ApplyOutcome,
} from "@/lib/user-import/apply";
import {
  applyRequestSchema,
  previewRequestSchema,
  type ApplyResponse,
  type FileIssue,
  type InviteCounts,
  type PreviewResponse,
  type ResultRow,
} from "@/lib/user-import/contract";
import { parseImportCsv } from "@/lib/user-import/csv";
import {
  sendImportInvites,
  type InviteAttempt,
} from "@/lib/user-import/invites";
import { buildImportPlan, type ImportPlan } from "@/lib/user-import/plan";

/** One import is one transaction, so it gets more than the 5 s default. */
const IMPORT_TIMEOUT_MS = 20_000;

export interface UserImportDeps {
  prisma: PrismaClient;
  /** Fresh-auth guard, adapted: the 403 `REAUTH_REQUIRED` response, or null. */
  requireFreshAuth(headers: Headers): Promise<Response | null>;
  sendInvite(userId: string, actorId: string): Promise<InviteAttempt>;
  sleep(ms: number): Promise<void>;
}

export type UserImportHandler = (request: Request) => Promise<Response>;

const toPreview = (plan: ImportPlan): PreviewResponse => ({
  digest: plan.digest,
  summary: plan.summary,
  rows: plan.rows.map(({ row }) => row),
});

const invalidFile = (issues: FileIssue[]) =>
  apiError(422, "INVALID_FILE", "This file can't be imported.", { issues });

type Outcome =
  | { kind: "changed"; plan: ImportPlan }
  | { kind: "applied"; plan: ImportPlan; applied: ApplyOutcome };

export function createUserImportHandlers(deps: UserImportDeps) {
  const { prisma } = deps;

  /** Wraps a handler so an unexpected throw is a logged 500, not a leak. */
  function guarded(action: string, fn: UserImportHandler): UserImportHandler {
    return async (request) => {
      try {
        return await fn(request);
      } catch (err) {
        logger.error("user_import_failed", {
          action,
          errorName: err instanceof Error ? err.name : "unknown",
        });
        return apiError(
          500,
          "INTERNAL_ERROR",
          "The import failed and nothing was changed. Try again.",
        );
      }
    };
  }

  // A dry run: validates and diffs the file, writes nothing.
  const preview = guarded("preview", async (request) => {
    const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
    if ("response" in guard) return guard.response;
    const body = await readJson(request, previewRequestSchema);
    if ("response" in body) return body.response;

    const parsed = parseImportCsv(body.data.csv);
    if (!parsed.ok) return invalidFile(parsed.errors);
    const plan = await buildImportPlan(parsed.rows, guard.actor, {
      db: prisma,
    });
    return apiJson(toPreview(plan));
  });

  const apply = guarded("apply", async (request) => {
    const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    const stale = await deps.requireFreshAuth(request.headers);
    if (stale) return stale;
    const body = await readJson(request, applyRequestSchema);
    if ("response" in body) return body.response;
    const { csv, digest, skipInvalid, sendInvites } = body.data;

    const parsed = parseImportCsv(csv);
    if (!parsed.ok) return invalidFile(parsed.errors);

    let outcome: Outcome;
    try {
      outcome = await withAuditTransaction(
        prisma,
        (tx) =>
          withAuditContext(
            {
              actor: { actorType: "USER", actorUserId: actor.id },
              ...auditRequestInfo(request.headers),
            },
            async (): Promise<Outcome> => {
              // Re-planned on the transaction, with the rows locked, so what is
              // written is what the digest vouches for.
              const plan = await buildImportPlan(parsed.rows, actor, {
                db: tx,
                lock: true,
              });
              if (plan.digest !== digest) return { kind: "changed", plan };

              const applied = await applyImportPlan(plan, {
                tx,
                actorId: actor.id,
                skipInvalid,
              });
              await auditMany(auditEventsFor(applied));
              await audit({
                type: "BULK_IMPORT",
                metadata: {
                  source: "csv",
                  rows: plan.summary.rows,
                  created: applied.createdUsers.length,
                  updated: plan.summary.update,
                  unchanged: plan.summary.unchanged,
                  skipped: plan.summary.invalid,
                  positionsAssigned: applied.insertedPairs.length,
                  skipInvalid,
                  sendInvites,
                },
              });
              return { kind: "applied", plan, applied };
            },
          ),
        { timeout: IMPORT_TIMEOUT_MS },
      );
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      if (err.code === "INVALID_ROWS" && err.plan) {
        return apiError(
          422,
          "INVALID_ROWS",
          "Some rows have problems. Fix them or skip them.",
          { preview: toPreview(err.plan) },
        );
      }
      return apiError(
        409,
        err.code,
        err.code === "POSITION_LIMIT"
          ? "A user would hold more than the maximum number of positions."
          : "Someone else changed these accounts at the same time. Preview again.",
      );
    }

    if (outcome.kind === "changed") {
      return apiError(
        409,
        "PLAN_CHANGED",
        "Accounts or positions changed since your preview. Review the updated preview before importing.",
        { preview: toPreview(outcome.plan) },
      );
    }

    // After the commit, so a send problem never undoes the import.
    let invited: Awaited<ReturnType<typeof sendImportInvites>> | null = null;
    if (sendInvites) {
      try {
        invited = await sendImportInvites(
          outcome.applied.rows.flatMap(({ result, userId }) =>
            result !== "skipped" && userId !== null ? [userId] : [],
          ),
          {
            sendInvite: (userId) => deps.sendInvite(userId, actor.id),
            db: prisma,
            sleep: deps.sleep,
          },
        );
      } catch (err) {
        logger.error("user_import_invites_failed", {
          errorName: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    return apiJson(
      toApplyResponse(outcome, invited?.statuses, invited?.counts ?? null),
    );
  });

  return { preview, apply };
}

export type UserImportHandlers = ReturnType<typeof createUserImportHandlers>;

/** One `USER_CREATED` per created account and one `POSITION_ASSIGNED` per inserted pair. */
function auditEventsFor(applied: ApplyOutcome): AuditCall<AuditEventType>[] {
  return [
    ...applied.createdUsers.map(
      (user): AuditCall<"USER_CREATED"> => ({
        type: "USER_CREATED",
        targetType: "USER",
        targetId: user.id,
        metadata: { source: "bulk_import" },
      }),
    ),
    ...applied.insertedPairs.map(
      (pair): AuditCall<"POSITION_ASSIGNED"> => ({
        type: "POSITION_ASSIGNED",
        targetType: "USER",
        targetId: pair.userId,
        metadata: { positionId: pair.positionId },
      }),
    ),
  ];
}

function toApplyResponse(
  { plan, applied }: Extract<Outcome, { kind: "applied" }>,
  statuses: ReadonlyMap<string, NonNullable<ResultRow["invite"]>> | undefined,
  invites: InviteCounts | null,
): ApplyResponse {
  return {
    summary: plan.summary,
    invites,
    rows: plan.rows.map(({ row }, index): ResultRow => {
      const result = applied.rows[index];
      const outcome = result?.result ?? "skipped";
      const userId = result?.userId ?? null;
      // A skipped row never invites, even when its address repeats a valid row.
      const invite =
        outcome === "skipped" || userId === null
          ? undefined
          : statuses?.get(userId);
      return {
        ...row,
        result: outcome,
        ...(invite === undefined ? {} : { invite }),
      };
    }),
  };
}
