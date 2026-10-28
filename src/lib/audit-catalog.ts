import { z } from "zod";

// Pure on purpose: loads in Next, Vitest and the ops scripts under plain Node,
// where `server-only` throws. Runtime helpers live in audit.ts.

export const AUDIT_EVENT_TYPES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "SESSION_REVOKED",
  "SESSIONS_REVOKED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET",
  "PASSWORD_SET_REQUESTED",
  "PASSWORD_SET",
  "PASSWORD_CHANGED",
  "PASSWORD_REHASHED",
  "EMAIL_VERIFIED",
  "USER_CREATED",
  "USER_INVITED",
  "USER_UPDATED",
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
  "PA_BOOTSTRAPPED",
  "BREAK_GLASS_PA_RECOVERY",
  "ACCOUNT_LOCKED",
  "ACCOUNT_UNLOCKED",
  "MFA_ENROLLED",
  "MFA_DISABLED",
  "MFA_RESET",
  "MFA_BACKUP_USED",
  "MFA_BACKUP_CODES_REGENERATED",
  "REAUTH_SUCCEEDED",
  "REAUTH_FAILED",
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

// Position metadata holds position fields only. User ids are the one piece of
// person data, and only in POSITION_DELETED's holderIds (as in positionOnUser).
const positionSnapshot = z.strictObject({
  key: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
});

const positionChanges = z.strictObject({
  name: z.string().optional(),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const hasChange = (changes: Record<string, unknown>) =>
  Object.keys(changes).length > 0;

const positionUpdatedMetadata = z
  .strictObject({ before: positionChanges, after: positionChanges })
  .refine(({ after }) => hasChange(after), {
    message: "a position update must change at least one field",
  })
  .refine(
    ({ before, after }) =>
      Object.keys(before).sort().join() === Object.keys(after).sort().join(),
    { message: "before and after must name the same fields" },
  );

/**
 * Why a Primary Admin transfer was cancelled. The last two are written only by
 * the scheduled job; the rest come from a person.
 */
export const TRANSFER_CANCEL_REASONS = [
  "cancelled",
  "declined",
  "recipient_ineligible",
  "sender_not_primary_admin",
] as const;

export type TransferCancelReason = (typeof TRANSFER_CANCEL_REASONS)[number];

const breakGlassOperator = z.string().trim().min(1).max(100);
const breakGlassReason = z.string().trim().min(10).max(500);

export const AUDIT_CATALOG = {
  LOGIN_SUCCESS: {
    targetType: "USER",
    metadata: z.strictObject({
      method: z.enum([
        "password",
        "email_verification",
        "totp",
        "backup_code",
        "other",
      ]),
    }),
  },
  LOGIN_FAILED: {
    targetType: "USER",
    metadata: z.strictObject({
      reason: z.enum([
        "INVALID_EMAIL_OR_PASSWORD",
        "EMAIL_NOT_VERIFIED",
        "ACCOUNT_DEACTIVATED",
        "ACCOUNT_LOCKED",
        "INVALID_TWO_FACTOR_CODE",
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
  // A set-password link was issued (AUTH-T22). Written only when a token is
  // actually issued, so an unknown or password-holding address leaves no row.
  PASSWORD_SET_REQUESTED: {
    targetType: "USER",
    metadata: z.strictObject({
      via: z.enum(["sign_in", "sign_up", "link_request"]),
    }),
  },
  // A password-less account set its first password through the emailed link.
  PASSWORD_SET: userTarget,
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
      // Set by the admin create endpoint only: whether an invite was issued.
      invited: z.boolean().optional(),
    }),
  },
  USER_INVITED: userTarget,
  // An admin edited a profile. Field names only, never the values (PII).
  USER_UPDATED: {
    targetType: "USER",
    metadata: z.strictObject({
      fields: z
        .array(z.enum(["name", "preferredName"]))
        .min(1)
        .max(2),
    }),
  },
  USER_DEACTIVATED: {
    targetType: "USER",
    metadata: z.strictObject({ revokedSessions: z.int().min(0) }),
  },
  USER_REACTIVATED: userTarget,
  // The tombstone (docs/DATA_HANDLING.md). `removedPositionIds` stands in for
  // one POSITION_UNASSIGNED per position, so a delete writes a single row.
  USER_DELETED: {
    targetType: "USER",
    metadata: z.strictObject({
      reason: z.enum(["admin"]),
      removedPositionIds: z.array(z.string().min(1)).max(50),
    }),
  },
  ADMIN_GRANTED: userTarget,
  ADMIN_REVOKED: userTarget,
  POSITION_CREATED: {
    targetType: "POSITION",
    metadata: z.strictObject({ after: positionSnapshot }),
  },
  POSITION_UPDATED: {
    targetType: "POSITION",
    metadata: positionUpdatedMetadata,
  },
  POSITION_DELETED: {
    targetType: "POSITION",
    metadata: z.strictObject({
      before: positionSnapshot,
      after: z.strictObject({ deletedAt: z.iso.datetime() }),
      holderIds: z.array(z.uuid()),
    }),
  },
  // Target the user so the user timeline can use the (targetType, targetId,
  // createdAt) index. Position-side history reads metadata.positionId.
  POSITION_ASSIGNED: positionOnUser,
  POSITION_UNASSIGNED: positionOnUser,
  PRODUCT_CREATED: productTarget,
  PRODUCT_UPDATED: productTarget,
  PRODUCT_DELETED: productTarget,
  PA_TRANSFER_INITIATED: transferTarget,
  PA_TRANSFER_ACCEPTED: transferTarget,
  // `via` says which door the cancel came through. The transfer row already
  // holds both parties, so no name or address is recorded here.
  PA_TRANSFER_CANCELLED: {
    targetType: "TRANSFER",
    metadata: z.strictObject({
      reason: z.enum(TRANSFER_CANCEL_REASONS),
      via: z.enum(["in_app", "email_link", "system"]),
    }),
  },
  PA_TRANSFER_COMPLETED: transferTarget,
  PA_TRANSFER_EXPIRED: transferTarget,
  // The one-time promotion of the first Primary Admin
  // (scripts/bootstrap-primary-admin.ts). Targets the promoted user.
  PA_BOOTSTRAPPED: {
    targetType: "USER",
    metadata: z.strictObject({ sessionsRevoked: z.int().min(0) }),
  },
  // Both modes of scripts/recover-primary-admin.ts share one type, told apart
  // by `mode`, so a single alert on this type covers MFA resets too.
  BREAK_GLASS_PA_RECOVERY: {
    targetType: "USER",
    metadata: z.discriminatedUnion("mode", [
      z.strictObject({
        mode: z.literal("transfer"),
        operator: breakGlassOperator,
        reason: breakGlassReason,
        previousPrimaryAdminId: z.string().min(1).nullable(),
        previousAdminRevoked: z.boolean(),
        cancelledTransferId: z.string().min(1).optional(),
        sessionsRevoked: z.int().min(0),
      }),
      z.strictObject({
        mode: z.literal("reset_mfa"),
        operator: breakGlassOperator,
        reason: breakGlassReason,
        sessionsRevoked: z.int().min(0),
      }),
    ]),
  },
  // Written when a failure takes the lock (docs/LOCKOUT.md). Numbers only, so
  // the row carries no address.
  ACCOUNT_LOCKED: {
    targetType: "USER",
    metadata: z.strictObject({
      lockLevel: z.int().min(1),
      durationMinutes: z.int().positive(),
    }),
  },
  // `admin` is reserved for the admin unlock endpoint.
  ACCOUNT_UNLOCKED: {
    targetType: "USER",
    metadata: z.strictObject({
      method: z.enum(["email_link", "password_reset", "admin"]),
    }),
  },
  MFA_ENROLLED: userTarget,
  MFA_DISABLED: userTarget,
  // An admin reset another user's MFA. Apart from MFA_DISABLED, which is the
  // user's own, so an alert can watch admin resets alone.
  MFA_RESET: userTarget,
  MFA_BACKUP_USED: userTarget,
  MFA_BACKUP_CODES_REGENERATED: userTarget,
  // Re-authentication for a sensitive action. `method` names the factors that
  // were checked; `reason` never says which one was wrong.
  REAUTH_SUCCEEDED: {
    targetType: "USER",
    metadata: z.strictObject({
      method: z.enum(["password", "password_totp", "password_backup_code"]),
    }),
  },
  REAUTH_FAILED: {
    targetType: "USER",
    metadata: z.strictObject({
      reason: z.enum(["INVALID_CREDENTIALS", "ACCOUNT_LOCKED"]),
    }),
  },
  BULK_IMPORT: noTarget,
  JWKS_ROTATED: noTarget,
} as const satisfies { [K in AuditEventType]: AuditEventSpec };

export type AuditMetadata<T extends AuditEventType> = z.input<
  (typeof AUDIT_CATALOG)[T]["metadata"]
>;

const USER_AGENT_MAX_LENGTH = 512;

export const ipSchema = z.union([z.ipv4(), z.ipv6()]);

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
