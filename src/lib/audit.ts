import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ipSchema,
  parseAuditEvent,
  type AuditActor,
  type AuditEventType,
  type AuditMetadata,
  type AuditTargetType,
} from "./audit-catalog";

// The types, catalog and input schema live in audit-catalog.ts so the ops
// scripts can load them; everything importing "@/lib/audit" is unchanged.
export * from "./audit-catalog";

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
