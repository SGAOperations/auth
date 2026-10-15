import { z } from "zod";

// Pure on purpose: no `server-only`, so tests and tooling can validate lines.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_ENVS = [
  "production",
  "dev",
  "preview",
  "local",
  "unknown",
] as const;

export type LogEnv = (typeof LOG_ENVS)[number];

/**
 * The contract for one structured log line. Strict on purpose: a stray
 * top-level field, `email` included, fails validation.
 */
export const logLineSchema = z
  .object({
    time: z.iso.datetime(),
    level: z.enum(LOG_LEVELS),
    msg: z.string().min(1),
    service: z.literal("sgauth"),
    env: z.enum(LOG_ENVS),
    requestId: z.string().min(1).max(128).optional(),
    route: z.string().optional(),
    method: z.string().optional(),
    path: z
      .string()
      .refine((value) => !value.includes("?"), "must not carry a query string")
      .optional(),
    userId: z.uuid().optional(),
    status: z.number().int().optional(),
    latencyMs: z.number().nonnegative().optional(),
    outcome: z
      .enum(["success", "client_error", "server_error", "exception"])
      .optional(),
    err: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
        cause: z.unknown().optional(),
      })
      .optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type LogLine = z.infer<typeof logLineSchema>;
