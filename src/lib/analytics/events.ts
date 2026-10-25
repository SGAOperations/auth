import { z } from "zod";
import { AUDIT_CATALOG } from "@/lib/audit-catalog";

// Pure on purpose: no `server-only` and no env reads, so it loads in Vitest.

// The PII boundary for analytics. Every event has a strict property schema,
// the same approach as AUDIT_CATALOG: an event whose properties do not match
// is dropped, never sent. Adding a property means widening a schema here.

const NO_PROPERTIES = z.strictObject({});

export const ANALYTICS_EVENTS = {
  login_succeeded: z.strictObject({
    method: z.enum(["password", "email_verification", "other"]),
  }),
  // Shares the audit event's reason enum so the two never drift.
  login_failed: z.strictObject({
    reason: AUDIT_CATALOG.LOGIN_FAILED.metadata.shape.reason,
  }),
  signup_started: NO_PROPERTIES,
  signup_completed: NO_PROPERTIES,
  reset_requested: NO_PROPERTIES,
  reset_completed: NO_PROPERTIES,
  mfa_enrolled: NO_PROPERTIES,
  account_locked: NO_PROPERTIES,
  session_endpoint_error: z.strictObject({
    status: z.number().int().min(500).max(599).nullable(),
    kind: z.enum(["server_error", "exception"]),
  }),
} as const;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

export type AnalyticsProperties<E extends AnalyticsEventName> = z.input<
  (typeof ANALYTICS_EVENTS)[E]
>;

export interface CaptureBase {
  sgauth_env: string;
  request_id?: string;
}

export interface CaptureMessage {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

// Any 8-4-4-4-12 hex id, not only RFC variants.
const uuid = z.guid();

/**
 * Builds the message to send, or null when the properties fail the event's
 * schema or `userId` is not a UUID. Without a user the distinct id is a fresh
 * random UUID and no person profile is created.
 */
export function buildCapture<E extends AnalyticsEventName>(
  event: E,
  input: { userId?: string; properties: AnalyticsProperties<E> },
  base: CaptureBase,
): CaptureMessage | null {
  const parsed = ANALYTICS_EVENTS[event].safeParse(input.properties);
  if (!parsed.success) return null;
  if (input.userId !== undefined && !uuid.safeParse(input.userId).success) {
    return null;
  }

  return {
    distinctId: input.userId ?? crypto.randomUUID(),
    event,
    properties: {
      ...parsed.data,
      sgauth_env: base.sgauth_env,
      ...(base.request_id ? { request_id: base.request_id } : {}),
      ...(input.userId === undefined ? { $process_person_profile: false } : {}),
    },
  };
}
