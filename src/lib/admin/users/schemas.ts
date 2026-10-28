import { z } from "zod";
import {
  POSITION_KEY_MAX,
  POSITION_KEY_MIN,
  POSITION_KEY_PATTERN,
} from "@/lib/position-key";

// Pure: zod only, no database and no `server-only`, so the tests and a future
// client can load it.

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const personName = z.string().trim().min(1).max(100);

/** The `[id]` path segment. A malformed id is handled as an unknown one. */
export const userIdParam = z.uuid();

const booleanFlag = z.enum(["true", "false"]).transform((v) => v === "true");

export const listQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  position: z
    .string()
    .min(POSITION_KEY_MIN)
    .max(POSITION_KEY_MAX)
    .regex(POSITION_KEY_PATTERN)
    .optional(),
  status: z.enum(["ACTIVE", "DEACTIVATED", "DELETED"]).optional(),
  isAdmin: booleanFlag.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export type ListQuery = z.output<typeof listQuery>;

export const createBody = z.strictObject({
  // Any domain: admins may create any address (design summary, "Login method").
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  name: personName,
  preferredName: personName.optional(),
  sendInvite: z.boolean().default(true),
});

export type CreateBody = z.output<typeof createBody>;

export const patchBody = z
  .strictObject({
    name: personName.optional(),
    preferredName: personName.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Send at least one field to change",
  });

export type PatchBody = z.output<typeof patchBody>;

export const ADMIN_USER_ACTIONS = [
  "deactivate",
  "reactivate",
  "grant-admin",
  "revoke-admin",
  "revoke-sessions",
  "unlock",
  "reset-mfa",
  "resend-invite",
] as const;

export type AdminUserAction = (typeof ADMIN_USER_ACTIONS)[number];

/** The `[action]` path segment. Case matters: "Deactivate" is unknown. */
export const actionParam = z.enum(ADMIN_USER_ACTIONS);
