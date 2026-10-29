import { createHash, timingSafeEqual } from "node:crypto";

// Pure on purpose: no `server-only`, no env and no Prisma, so the auth check
// and the response shapes are unit-testable. `server.ts` wires the secret.

export type JobResult = Record<string, unknown>;

/** Thrown by a job for a request it refuses to act on; answered 400, not 500. */
export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

/**
 * Most jobs take no input and ignore the request. One that does, such as a dry
 * run flag, reads the URL only: the body is never parsed.
 */
export type JobRun = (req: Request) => Promise<JobResult>;

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
  /** Awaited after a job throws, before the 500 goes out. Its own failure is logged and ignored. */
  onFailure?: (name: string) => Promise<void> | void;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Wraps a job in the bearer check. The request body is ignored. Every
 * unauthorized case answers the same 401, so a caller learns nothing about why
 * it was refused.
 */
export function createJobHandler({
  name,
  run,
  secret,
  log,
  onFailure,
}: JobHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!isAuthorized(req.headers.get("authorization"), secret)) {
      if (secret) log.warn("job.unauthorized", { job: name });
      else log.warn("job.secret_unset", { job: name });
      return json({ error: "unauthorized" }, 401);
    }

    try {
      const result = await run(req);
      log.info("job.completed", { job: name, ...result });
      return json({ job: name, ok: true, result }, 200);
    } catch (err) {
      if (err instanceof JobInputError) {
        return json({ job: name, ok: false, error: "bad_request" }, 400);
      }
      log.error("job.failed", { job: name, err });
      try {
        await onFailure?.(name);
      } catch (hookErr) {
        log.error("job.on_failure_failed", { job: name, err: hookErr });
      }
      return json({ job: name, ok: false, error: "job_failed" }, 500);
    }
  };
}
