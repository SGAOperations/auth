import { z } from "zod";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";

// Pure on purpose: no `server-only`, no env, no DB. The SDK (#69/#70) copies
// this file verbatim. Every object is strict, so a field added to a response
// without a schema change fails the contract tests. Docs: docs/SESSION-ENDPOINT.md.

export const positionSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
});

export const sessionUserSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  preferredName: z.string().nullable(),
  isAdmin: z.boolean(),
  isPrimaryAdmin: z.boolean(),
});

export const sessionInfoSchema = z.strictObject({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const sessionResponseSchema = z.strictObject({
  user: sessionUserSchema,
  positions: z.array(positionSchema).max(MAX_ACTIVE_POSITIONS_PER_USER),
  session: sessionInfoSchema,
});

/** A strict subset of the full shape, so `user.id` and `positions` read the same from either. */
export const minimalSessionResponseSchema = z.strictObject({
  user: z.strictObject({ id: z.uuid() }),
  positions: z.array(positionSchema).max(MAX_ACTIVE_POSITIONS_PER_USER),
});

export const unauthenticatedResponseSchema = z.strictObject({
  error: z.literal("unauthenticated"),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type MinimalSessionResponse = z.infer<
  typeof minimalSessionResponseSchema
>;
export type UnauthenticatedResponse = z.infer<
  typeof unauthenticatedResponseSchema
>;

export const UNAUTHENTICATED_BODY = {
  error: "unauthenticated",
} as const satisfies UnauthenticatedResponse;

export const SESSION_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

/**
 * Published JSON Schemas, keyed by the file name under docs/api/. The files are
 * generated from these by contract.test.ts.
 */
export const SESSION_JSON_SCHEMAS = {
  "sgauth-session.schema.json": z.toJSONSchema(
    sessionResponseSchema.meta({ title: "SGAuth session response" }),
    { target: "draft-2020-12" },
  ),
  "sgauth-session-minimal.schema.json": z.toJSONSchema(
    minimalSessionResponseSchema.meta({
      title: "SGAuth minimal session response",
    }),
    { target: "draft-2020-12" },
  ),
  "sgauth-session-unauthenticated.schema.json": z.toJSONSchema(
    unauthenticatedResponseSchema.meta({
      title: "SGAuth unauthenticated response",
    }),
    { target: "draft-2020-12" },
  ),
} as const;
