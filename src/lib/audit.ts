import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

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
  "PA_TRANSFER_INITIATED",
  "PA_TRANSFER_ACCEPTED",
  "PA_TRANSFER_CANCELLED",
  "PA_TRANSFER_COMPLETED",
  "PA_TRANSFER_EXPIRED",
  "BREAK_GLASS_PA_RECOVERY",
  "ACCOUNT_LOCKED",
  "ACCOUNT_UNLOCKED",
  "MFA_ENROLLED",
  "MFA_DISABLED",
  "MFA_BACKUP_USED",
  "BULK_IMPORT",
  "JWKS_ROTATED",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_TARGET_TYPES = [
  "USER",
  "POSITION",
  "PRODUCT",
  "SESSION",
  "TRANSFER",
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const AUDIT_ACTOR_TYPES = ["USER", "SYSTEM", "BREAK_GLASS"] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditActor {
  actorType: AuditActorType;
  actorUserId?: string | null;
}

interface AuditEventSpec {
  /** Required target type, or null for an event with no target. */
  targetType: AuditTargetType | null;
  /** Strict on purpose: the catalog is what keeps PII out of audit rows. */
  metadata: z.ZodType;
}

// An empty strict object means "no metadata". A ticket that needs metadata for
// its event widens the schema here, so every PII decision is made in one file.
const noMetadata = z.strictObject({});

const userTarget = { targetType: "USER", metadata: noMetadata } as const;
const positionTarget = {
  targetType: "POSITION",
  metadata: noMetadata,
} as const;
const productTarget = { targetType: "PRODUCT", metadata: noMetadata } as const;
const transferTarget = {
  targetType: "TRANSFER",
  metadata: noMetadata,
} as const;
const noTarget = { targetType: null, metadata: noMetadata } as const;
const sessionTarget = { targetType: "SESSION", metadata: noMetadata } as const;

const positionOnUser = {
  targetType: "USER",
  metadata: z.strictObject({ positionId: z.string().min(1) }),
} as const;

export const AUDIT_CATALOG = {
  LOGIN_SUCCESS: {
    targetType: "USER",
    metadata: z.strictObject({
      method: z.enum(["password", "email_verification", "other"]),
    }),
  },
  LOGIN_FAILED: {
    targetType: "USER",
    metadata: z.strictObject({
      reason: z.enum([
        "INVALID_EMAIL_OR_PASSWORD",
        "EMAIL_NOT_VERIFIED",
        "ACCOUNT_DEACTIVATED",
        "OTHER",
      ]),
    }),
  },
  LOGOUT: sessionTarget,
  SESSION_REVOKED: sessionTarget,
  SESSIONS_REVOKED: {
    targetType: "USER",
    metadata: z.strictObject({ scope: z.enum(["all", "others"]) }),
  },
  PASSWORD_RESET_REQUESTED: userTarget,
  PASSWORD_RESET: userTarget,
  PASSWORD_CHANGED: {
    targetType: "USER",
    metadata: z.strictObject({ revokedOtherSessions: z.boolean() }),
  },
  PASSWORD_REHASHED: userTarget,
  EMAIL_VERIFIED: userTarget,
  USER_CREATED: {
    targetType: "USER",
    metadata: z.strictObject({
      source: z.enum(["self_signup", "admin", "system"]),
    }),
  },
  USER_INVITED: userTarget,
  USER_DEACTIVATED: userTarget,
  USER_REACTIVATED: userTarget,
  USER_DELETED: userTarget,
  ADMIN_GRANTED: userTarget,
  ADMIN_REVOKED: userTarget,
  POSITION_CREATED: positionTarget,
  POSITION_UPDATED: positionTarget,
  POSITION_DELETED: positionTarget,
  // Target the user so the user timeline can use the (targetType, targetId,
  // createdAt) index. Position-side history reads metadata.positionId.
  POSITION_ASSIGNED: positionOnUser,
  POSITION_UNASSIGNED: positionOnUser,
  PRODUCT_CREATED: productTarget,
  PRODUCT_UPDATED: productTarget,
  PRODUCT_DELETED: productTarget,
  PA_TRANSFER_INITIATED: transferTarget,
  PA_TRANSFER_ACCEPTED: transferTarget,
  PA_TRANSFER_CANCELLED: transferTarget,
  PA_TRANSFER_COMPLETED: transferTarget,
  PA_TRANSFER_EXPIRED: transferTarget,
  BREAK_GLASS_PA_RECOVERY: userTarget,
  ACCOUNT_LOCKED: userTarget,
  ACCOUNT_UNLOCKED: userTarget,
  MFA_ENROLLED: userTarget,
  MFA_DISABLED: userTarget,
  MFA_BACKUP_USED: userTarget,
  BULK_IMPORT: noTarget,
  JWKS_ROTATED: noTarget,
} as const satisfies { [K in AuditEventType]: AuditEventSpec };

export type AuditMetadata<T extends AuditEventType> = z.input<
  (typeof AUDIT_CATALOG)[T]["metadata"]
>;

const USER_AGENT_MAX_LENGTH = 512;

const ipSchema = z.union([z.ipv4(), z.ipv6()]);

// Mirrors the AuditEvent_actor_consistent and AuditEvent_target_pair CHECKs so
// a caller gets a ZodError before the database is involved. The per-type
// target and metadata rules live only here: the table has no CHECK on `type`.
export const auditEventInputSchema = z
  .object({
    type: z.enum(AUDIT_EVENT_TYPES),
    actorType: z.enum(AUDIT_ACTOR_TYPES),
    actorUserId: z.string().min(1).nullish(),
    targetType: z.enum(AUDIT_TARGET_TYPES).nullish(),
    targetId: z.string().min(1).nullish(),
    metadata: z.record(z.string(), z.json()).default({}),
    ip: ipSchema.nullish(),
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
  })
  .superRefine((event, ctx) => {
    const spec: AuditEventSpec = AUDIT_CATALOG[event.type];

    if (event.targetType && event.targetType !== spec.targetType) {
      ctx.addIssue({
        code: "custom",
        message: `${event.type} targets ${spec.targetType ?? "nothing"}, not ${event.targetType}`,
        path: ["targetType"],
      });
    }

    const metadata = spec.metadata.safeParse(event.metadata);
    if (!metadata.success) {
      for (const issue of metadata.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: ["metadata", ...issue.path],
        });
      }
    }

    if (
      (event.actorType === "BREAK_GLASS") !==
      (event.type === "BREAK_GLASS_PA_RECOVERY")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "the BREAK_GLASS actor is for BREAK_GLASS_PA_RECOVERY and nothing else",
        path: ["actorType"],
      });
    }
  });

export type AuditEventInput = z.output<typeof auditEventInputSchema>;

export function parseAuditEvent(input: unknown): AuditEventInput {
  return auditEventInputSchema.parse(input);
}

export type AuditDb = Pick<Prisma.TransactionClient, "auditEvent">;

// Throws on a bad event or a failed insert, so a failed audit write fails the
// caller's transaction. Both a PrismaClient and a $transaction `tx` fit.
export async function writeAuditEvent(db: AuditDb, input: unknown) {
  const data = parseAuditEvent(input);
  return db.auditEvent.create({ data });
}

interface AuditContext {
  actor?: AuditActor;
  ip?: string | null;
  userAgent?: string | null;
  db?: AuditDb;
}

const auditContext = new AsyncLocalStorage<AuditContext>();

/** Runs `fn` with defaults that `audit()` falls back to; nests over an outer context. */
export function withAuditContext<T>(context: AuditContext, fn: () => T): T {
  return auditContext.run({ ...auditContext.getStore(), ...context }, fn);
}

/**
 * Opens a transaction in which every `audit()` call writes through it, so a
 * failed audit rolls back the mutation it belongs to.
 */
export function withAuditTransaction<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction((tx) =>
    withAuditContext({ db: tx }, () => fn(tx)),
  );
}

/** The address when it is a valid IPv4 or IPv6, otherwise `null`; never a placeholder. */
export function auditIp(value: string | null | undefined): string | null {
  const parsed = ipSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : null;
}

/** Client IP and user agent from request headers; `null` when absent or malformed. */
export function auditRequestInfo(headers: Pick<Headers, "get">): {
  ip: string | null;
  userAgent: string | null;
} {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0];
  return {
    ip: auditIp(headers.get("x-real-ip")) ?? auditIp(forwarded),
    userAgent: headers.get("user-agent"),
  };
}

type AuditCallMetadata<T extends AuditEventType> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the "all keys optional" probe
  {} extends AuditMetadata<T>
    ? { metadata?: AuditMetadata<T> }
    : { metadata: AuditMetadata<T> };

export type AuditCall<T extends AuditEventType> = {
  type: T;
  targetType?: AuditTargetType;
  targetId?: string;
  ip?: string | null;
  userAgent?: string | null;
} & Partial<AuditActor> &
  AuditCallMetadata<T>;

interface AuditOptions {
  db?: AuditDb;
  headers?: Pick<Headers, "get">;
}

async function requestHeaders(): Promise<Pick<Headers, "get"> | null> {
  try {
    return await (await import("next/headers")).headers();
  } catch {
    // Outside a request scope.
    return null;
  }
}

/**
 * Writes one catalog event. The actor comes from the call or the surrounding
 * context, never a default: a user action must not be silently mislabelled as
 * SYSTEM. IP and user agent come from the call, `options.headers`, the
 * context, then the current Next.js request. Writes through the open
 * transaction when there is one, and throws on any failure.
 */
export async function audit<T extends AuditEventType>(
  event: AuditCall<T>,
  options: AuditOptions = {},
) {
  const context = auditContext.getStore();

  const actor: AuditActor | undefined = event.actorType
    ? { actorType: event.actorType, actorUserId: event.actorUserId }
    : context?.actor;
  if (!actor) throw new Error(`audit(): no actor for ${event.type}`);

  const fromOptions = options.headers
    ? auditRequestInfo(options.headers)
    : null;
  let ip = event.ip ?? fromOptions?.ip ?? auditIp(context?.ip);
  let userAgent =
    event.userAgent ?? fromOptions?.userAgent ?? context?.userAgent ?? null;
  if (!options.headers && (ip == null || userAgent == null)) {
    const headers = await requestHeaders();
    const fromRequest = headers ? auditRequestInfo(headers) : null;
    ip ??= fromRequest?.ip ?? null;
    userAgent ??= fromRequest?.userAgent ?? null;
  }

  let db = options.db ?? context?.db;
  if (!db) db = (await import("@/lib/prisma")).prisma;

  return writeAuditEvent(db, { ...event, ...actor, ip, userAgent });
}

export const AUDIT_ANONYMIZE_SETTING = "sgauth.audit_anonymize";

// Opens the anonymization gate for one transaction. SET LOCAL is
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
