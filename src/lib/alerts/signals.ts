import "server-only";
import { after } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";

// Operational signals the security-alert job reads: events that are not audit
// actions, so they stay out of the AuditEvent catalog. Like that catalog, each
// kind has a strict schema, so `detail` can never carry an IP, an email, a key,
// a token or an error message.

const failOpenReason = z.enum(["timeout", "error"]);

export const OPS_SIGNAL_CATALOG = {
  RATE_LIMIT_FAIL_OPEN: z.strictObject({
    policy: z.string().min(1).max(64),
    rule: z.string().min(1).max(64),
    reason: failOpenReason,
  }),
  EMAIL_CAP_FAIL_OPEN: z.strictObject({ reason: failOpenReason }),
  JOB_FAILED: z.strictObject({
    job: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  }),
} as const;

export type OpsSignalKind = keyof typeof OPS_SIGNAL_CATALOG;

export const OPS_SIGNAL_KINDS = Object.keys(OPS_SIGNAL_CATALOG) as [
  OpsSignalKind,
  ...OpsSignalKind[],
];

export type OpsSignalDetail<K extends OpsSignalKind> = z.input<
  (typeof OPS_SIGNAL_CATALOG)[K]
>;

export type OpsSignalInput = {
  [K in OpsSignalKind]: { kind: K; detail: OpsSignalDetail<K> };
}[OpsSignalKind];

export type OpsSignalDb = Pick<Prisma.TransactionClient, "opsSignal">;

export interface OpsSignalLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface RecordOptions {
  db?: OpsSignalDb;
  log?: OpsSignalLog;
}

/**
 * Writes one signal. It never rejects: a signal is recorded from inside the
 * sign-in path and the job runner's failure path, and neither may fail because
 * the signal could not be stored. Logs the kind and the error name only.
 */
export async function recordOpsSignal(
  signal: OpsSignalInput,
  options: RecordOptions = {},
): Promise<void> {
  try {
    const detail = OPS_SIGNAL_CATALOG[signal.kind].parse(signal.detail);
    // Lazy, like audit(): pure tests never parse the environment.
    const db = options.db ?? (await import("@/lib/prisma")).prisma;
    await db.opsSignal.create({ data: { kind: signal.kind, detail } });
  } catch (error) {
    try {
      const log = options.log ?? (await import("@/lib/log")).logger;
      log.error("[ALERT] ops signal write failed", {
        kind: signal.kind,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    } catch {
      // Nothing left to report to.
    }
  }
}

/**
 * Records a signal after the response has gone out, so the insert is never part
 * of a request's latency. Outside a request scope `after` throws, and the
 * signal is written directly.
 */
export function deferSignal(signal: OpsSignalInput): void {
  try {
    after(() => recordOpsSignal(signal));
  } catch {
    void recordOpsSignal(signal);
  }
}
