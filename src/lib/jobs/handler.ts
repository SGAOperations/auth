import { createHash, timingSafeEqual } from "node:crypto";

// Pure on purpose: no `server-only`, no env and no Prisma, so the auth check
// and the response shapes are unit-testable. `server.ts` wires the secret.

export type JobResult = Record<string, unknown>;

export type JobRun = () => Promise<JobResult>;

export interface JobLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const BEARER_PREFIX = "Bearer ";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * True only for `Bearer <secret>`. Compares fixed-length digests, so neither a
 * length difference nor an early mismatch is observable. An unset secret
 * authorizes nothing.
 */
export function isAuthorized(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !header?.startsWith(BEARER_PREFIX)) return false;
  return timingSafeEqual(
    sha256(header.slice(BEARER_PREFIX.length)),
    sha256(secret),
  );
}

interface JobHandlerOptions {
  name: string;
  run: JobRun;
  secret: string | undefined;
  log: JobLogger;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Wraps a job in the bearer check. The request body is ignored: a job takes no
 * input. Every unauthorized case answers the same 401, so a caller learns
 * nothing about why it was refused.
 */
export function createJobHandler({
  name,
  run,
  secret,
  log,
}: JobHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!isAuthorized(req.headers.get("authorization"), secret)) {
      if (secret) log.warn("job.unauthorized", { job: name });
      else log.warn("job.secret_unset", { job: name });
      return json({ error: "unauthorized" }, 401);
    }

    try {
      const result = await run();
      log.info("job.completed", { job: name, ...result });
      return json({ job: name, ok: true, result }, 200);
    } catch (err) {
      log.error("job.failed", { job: name, err });
      return json({ job: name, ok: false, error: "job_failed" }, 500);
    }
  };
}

/** Body of a job whose ticket has not landed yet. It changes nothing. */
export function notImplementedJob(ticket: string): JobRun {
  return async () => ({ status: "not_implemented", ticket });
}
