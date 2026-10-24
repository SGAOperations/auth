import type { Logger } from "@/lib/log/logger";

// Pure on purpose: no `server-only` and no prisma import, so the runner is unit
// tested with fake probes. The real probes live in ./probes.ts.

export type HealthProbes = {
  pingDb(): Promise<void>;
  hasJwksKey(): Promise<boolean>;
  version: string;
};

export type HealthBody = {
  db: "ok" | "error";
  jwks: "ok" | "missing" | "error";
  version: string;
};

export type HealthResult = { status: 200 | 503; body: HealthBody };

// Under the 5 s pool connect timeout in src/lib/prisma.ts, so a hung connect
// still yields a 503 well inside a monitor's own timeout.
export const CHECK_TIMEOUT_MS = 3_000;

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs both probes concurrently. The body carries only coarse status values:
 * a failure's error goes to the log, never into the response.
 */
export async function runHealthChecks(
  probes: HealthProbes,
  log: Pick<Logger, "error">,
): Promise<HealthResult> {
  const [db, jwks] = await Promise.allSettled([
    withTimeout(probes.pingDb(), CHECK_TIMEOUT_MS),
    withTimeout(probes.hasJwksKey(), CHECK_TIMEOUT_MS),
  ]);

  if (db.status === "rejected") {
    log.error("health.check_failed", { err: db.reason, check: "db" });
  }
  if (jwks.status === "rejected") {
    log.error("health.check_failed", { err: jwks.reason, check: "jwks" });
  }

  const body: HealthBody = {
    db: db.status === "fulfilled" ? "ok" : "error",
    jwks: jwks.status === "rejected" ? "error" : jwks.value ? "ok" : "missing",
    version: probes.version,
  };
  const healthy = body.db === "ok" && body.jwks === "ok";
  return { status: healthy ? 200 : 503, body };
}
