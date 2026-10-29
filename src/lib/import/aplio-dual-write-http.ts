import { z } from "zod";
import { isAuthorized, type JobLogger } from "@/lib/jobs/handler";
import {
  aplioEmailSchema,
  aplioIdSchema,
  aplioNameSchema,
} from "@/lib/import/aplio";

// The request handler behind POST /api/provision/aplio/users. Pure on purpose:
// no `server-only`, no env and no database, so the status-code matrix is
// unit-testable. aplio-dual-write.ts wires the secret, the cutover and the
// provision service. Sends no mail and writes no Verification row.

export const aplioProvisionBodySchema = z.strictObject({
  aplioId: aplioIdSchema,
  email: aplioEmailSchema,
  name: aplioNameSchema,
});

export type AplioProvisionInput = z.output<typeof aplioProvisionBodySchema>;

export type AplioProvisionResult =
  | { status: "created" | "existing"; userId: string }
  | { status: "tombstoned" }
  | { status: "unverified" };

export interface AplioDualWriteOptions {
  /** Unset disables the endpoint. */
  secret: string | undefined;
  /** ISO-8601 with offset. Unset disables the endpoint. */
  cutoverAt: string | undefined;
  provision: (input: AplioProvisionInput) => Promise<AplioProvisionResult>;
  log: JobLogger;
  now: () => Date;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorFields(err: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    errorName: err instanceof Error ? err.name : "unknown",
  };
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
  ) {
    fields.errorCode = err.code;
  }
  return fields;
}

/**
 * Checks, in order: disabled (404, so it looks absent), bearer (401), window
 * (410), body (400), then provisions. Logs carry the Aplio id and the outcome,
 * never an address or a name.
 */
export function createAplioDualWriteHandler({
  secret,
  cutoverAt,
  provision,
  log,
  now,
}: AplioDualWriteOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!secret || !cutoverAt) return json({ error: "not_found" }, 404);

    if (!isAuthorized(req.headers.get("authorization"), secret)) {
      log.warn("aplio_dual_write.unauthorized");
      return json({ error: "unauthorized" }, 401);
    }

    if (now().getTime() >= Date.parse(cutoverAt)) {
      return json({ error: "cutover_passed" }, 410);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "bad_request", issues: ["$"] }, 400);
    }
    const parsed = aplioProvisionBodySchema.safeParse(raw);
    if (!parsed.success) {
      return json(
        {
          error: "bad_request",
          issues: parsed.error.issues.flatMap((issue) =>
            // An extra field is named by its key, which is not a value.
            issue.code === "unrecognized_keys"
              ? issue.keys.map((key) => [...issue.path, key].join("."))
              : [issue.path.join(".") || "$"],
          ),
        },
        400,
      );
    }

    const { aplioId } = parsed.data;
    try {
      const result = await provision(parsed.data);
      log.info("aplio_dual_write.provisioned", {
        aplioId,
        outcome: result.status,
      });
      if (result.status === "tombstoned") {
        return json({ error: "tombstoned" }, 409);
      }
      if (result.status === "unverified") {
        return json({ error: "unverified_account" }, 409);
      }
      return json({ sgauthUserId: result.userId, outcome: result.status }, 200);
    } catch (err) {
      log.error("aplio_dual_write.failed", { aplioId, ...errorFields(err) });
      return json({ error: "internal" }, 500);
    }
  };
}
