import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

// Starter catalog. AUTH-T73 (#85) completes it with the PA_TRANSFER_* and MFA_*
// families and per-type metadata.
export const AUDIT_EVENT_TYPES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "SESSION_REVOKED",
  "SESSIONS_REVOKED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "PASSWORD_REHASHED",
  "EMAIL_VERIFIED",
  "USER_CREATED",
  "USER_INVITED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "USER_DELETED",
  "ADMIN_GRANTED",
  "ADMIN_REVOKED",
  "POSITION_CREATED",
  "POSITION_UPDATED",
  "POSITION_DELETED",
  "POSITION_ASSIGNED",
  "POSITION_UNASSIGNED",
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_DELETED",
  "BREAK_GLASS_PA_RECOVERY",
  "ACCOUNT_LOCKED",
  "ACCOUNT_UNLOCKED",
  "BULK_IMPORT",
  "JWKS_ROTATED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

const USER_AGENT_MAX_LENGTH = 512;

// Mirrors the AuditEvent_actor_consistent and AuditEvent_target_pair CHECKs so
// a caller gets a ZodError before the database is involved.
export const auditEventInputSchema = z
  .object({
    type: z.enum(AUDIT_EVENT_TYPES),
    actorType: z.enum(["USER", "SYSTEM", "BREAK_GLASS"]),
    actorUserId: z.string().min(1).nullish(),
    targetType: z
      .enum(["USER", "POSITION", "PRODUCT", "SESSION", "TRANSFER"])
      .nullish(),
    targetId: z.string().min(1).nullish(),
    metadata: z.record(z.string(), z.json()).default({}),
    ip: z.union([z.ipv4(), z.ipv6()]).nullish(),
    userAgent: z
      .string()
      .nullish()
      .transform((value) => value?.slice(0, USER_AGENT_MAX_LENGTH)),
  })
  .refine(
    (event) => (event.actorType === "USER") === Boolean(event.actorUserId),
    {
      message:
        "actorUserId is required for USER actors and forbidden otherwise",
      path: ["actorUserId"],
    },
  )
  .refine((event) => Boolean(event.targetType) === Boolean(event.targetId), {
    message: "targetType and targetId must be set together",
    path: ["targetId"],
  });

export type AuditEventInput = z.output<typeof auditEventInputSchema>;

export function parseAuditEvent(input: unknown): AuditEventInput {
  return auditEventInputSchema.parse(input);
}

// Throws on a bad event or a failed insert, so a failed audit write fails the
// caller's transaction. Both a PrismaClient and a $transaction `tx` fit.
export async function writeAuditEvent(
  db: Pick<Prisma.TransactionClient, "auditEvent">,
  input: unknown,
) {
  const data = parseAuditEvent(input);
  return db.auditEvent.create({ data });
}

export const AUDIT_ANONYMIZE_SETTING = "sgauth.audit_anonymize";

// Opens the anonymization gate for one transaction (AUTH-T78). SET LOCAL is
// transaction-scoped, so it is safe behind Neon's transaction-mode pooler.
export async function withAuditAnonymization<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL sgauth.audit_anonymize = 'on'`;
    return fn(tx);
  });
}
