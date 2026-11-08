import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { decodeCursor, encodeCursor, type AuditCursor } from "@/lib/audit-log";

// Every query takes its client as an argument, as `audit-log.ts` does, so the
// pure tests never parse env.

export const ACCESS_REQUEST_PAGE_SIZE = 50;

const INVALID_CURSOR = "Invalid page marker.";

/** The page's search params. An empty `cursor` counts as absent; an array fails. */
export const accessRequestPageSchema = z.object({
  cursor: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .max(200, INVALID_CURSOR)
      .transform((value, ctx) => {
        const cursor = decodeCursor(value);
        if (!cursor) {
          ctx.addIssue({ code: "custom", message: INVALID_CURSOR });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
  ),
});

export interface AccessRequestRow {
  id: string;
  createdAt: Date;
  /** `null` when the requester was removed or is a tombstone. */
  requester: {
    name: string;
    preferredName: string | null;
    email: string;
  } | null;
  positionKey: string;
  positionName: string;
  product: string;
  access: string;
}

function cursorWhere(cursor: AuditCursor): Prisma.AccessRequestWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/** Newest first, one page. `nextCursor` is set only when an older row exists. */
export async function listAccessRequests(
  db: Pick<Prisma.TransactionClient, "accessRequest">,
  cursor?: AuditCursor,
): Promise<{ rows: AccessRequestRow[]; nextCursor: string | null }> {
  const found = await db.accessRequest.findMany({
    where: cursor ? cursorWhere(cursor) : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACCESS_REQUEST_PAGE_SIZE + 1,
    select: {
      id: true,
      createdAt: true,
      positionKey: true,
      positionName: true,
      product: true,
      access: true,
      requester: {
        select: { name: true, preferredName: true, email: true, status: true },
      },
    },
  });
  const page = found.slice(0, ACCESS_REQUEST_PAGE_SIZE);
  const last = page.at(-1);
  return {
    rows: page.map(({ requester, ...row }) => ({
      ...row,
      requester:
        requester && requester.status !== "DELETED"
          ? {
              name: requester.name,
              preferredName: requester.preferredName,
              email: requester.email,
            }
          : null,
    })),
    nextCursor:
      found.length > ACCESS_REQUEST_PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
