import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { toPositionError } from "@/lib/positions";
import type { RowResult } from "@/lib/user-import/contract";
import type { ImportPlan } from "@/lib/user-import/plan";

export type ImportErrorCode = "INVALID_ROWS" | "CONFLICT" | "POSITION_LIMIT";

/** Thrown inside the import's transaction so that nothing commits. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  /** The plan that was refused, for a code that answers with it. */
  readonly plan: ImportPlan | undefined;

  constructor(code: ImportErrorCode, plan?: ImportPlan) {
    super(code);
    this.name = "ImportError";
    this.code = code;
    this.plan = plan;
  }
}

export interface ApplyOutcome {
  createdUsers: { id: string; email: string }[];
  /** Only the pairs that were really inserted, never the ones already held. */
  insertedPairs: { userId: string; positionId: string }[];
  rows: { line: number; result: RowResult; userId: string | null }[];
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const RESULT: Record<"create" | "update" | "unchanged" | "invalid", RowResult> =
  {
    create: "created",
    update: "updated",
    unchanged: "unchanged",
    invalid: "skipped",
  };

/**
 * Writes a plan inside the caller's transaction. Does no authorization and
 * writes no audit row: the handler owns both, as `positions.ts` does. New
 * accounts have no `Account` row, which is the password-less shape: they cannot
 * sign in until the owner sets a password through an emailed link. Writing
 * through Prisma bypasses Better Auth's `user.create` hooks; the plan has
 * already normalised the email, and the handler writes `USER_CREATED`.
 */
export async function applyImportPlan(
  plan: ImportPlan,
  {
    tx,
    actorId,
    skipInvalid,
  }: { tx: Prisma.TransactionClient; actorId: string; skipInvalid: boolean },
): Promise<ApplyOutcome> {
  if (plan.summary.invalid > 0 && !skipInvalid) {
    throw new ImportError("INVALID_ROWS", plan);
  }

  const creates = plan.rows.filter(({ row }) => row.action === "create");
  let createdUsers: { id: string; email: string }[] = [];
  if (creates.length > 0) {
    try {
      createdUsers = await tx.user.createManyAndReturn({
        data: creates.map(({ row }) => ({
          email: row.email,
          name: row.name,
          emailVerified: true,
          status: "ACTIVE" as const,
        })),
        select: { id: true, email: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ImportError("CONFLICT");
      throw err;
    }
  }
  const createdId = new Map(
    createdUsers.map((user) => [user.email.toLowerCase(), user.id]),
  );

  const idOf = ({ row, userId }: ImportPlan["rows"][number]) =>
    userId ?? createdId.get(row.email) ?? null;

  const wanted = plan.rows.flatMap((entry) => {
    const userId = idOf(entry);
    return userId === null
      ? []
      : entry.positionIds.map((positionId) => ({ userId, positionId }));
  });
  let insertedPairs: ApplyOutcome["insertedPairs"] = [];
  if (wanted.length > 0) {
    try {
      insertedPairs = await tx.userPosition.createManyAndReturn({
        data: wanted.map((pair) => ({ ...pair, assignedById: actorId })),
        skipDuplicates: true,
        select: { userId: true, positionId: true },
      });
    } catch (err) {
      // The trigger is the real guarantee behind the plan's own check.
      if (toPositionError(err)?.code === "POSITION_LIMIT") {
        throw new ImportError("POSITION_LIMIT");
      }
      throw err;
    }
  }

  return {
    createdUsers,
    insertedPairs,
    rows: plan.rows.map((entry) => ({
      line: entry.row.line,
      result: RESULT[entry.row.action],
      userId: idOf(entry),
    })),
  };
}
