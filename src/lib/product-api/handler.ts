import type { z } from "zod";
import type { JobLogger } from "@/lib/jobs/handler";
import type { AuthenticatedProduct } from "@/lib/product-api-keys";

// The request handler shape behind every /api/products/* route. Pure on
// purpose: no `server-only`, no env and no database, so the status-code matrix
// is unit-testable; server.ts wires the key lookup and the rate limiter.
//
// These routes are called by a product's server, never a browser, so they sit
// outside /api/sgauth and its Origin guard, as /api/jobs and /api/provision do.
// The bearer key is the only credential; no cookie is read.

export type ProductApiResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 403 | 404 | 409 | 422; error: string };

export interface ProductApiOptions<S extends z.ZodType> {
  /** Route name for the logs. */
  name: string;
  /** Unset disables the route: it answers 404, so it looks absent. */
  enabled: boolean;
  schema: S;
  authenticate: (
    authorization: string | null,
  ) => Promise<AuthenticatedProduct | null>;
  /** Returns the 429 to send, or null to carry on. */
  limit: (product: AuthenticatedProduct) => Promise<Response | null>;
  run: (
    product: AuthenticatedProduct,
    input: z.output<S>,
  ) => Promise<ProductApiResult>;
  log: JobLogger;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Checks, in order: enabled (404), bearer key (401), rate limit (429), body
 * (400), then runs. Logs carry the product slug and the outcome; never the key,
 * and never a request body.
 */
export function createProductApiHandler<S extends z.ZodType>({
  name,
  enabled,
  schema,
  authenticate,
  limit,
  run,
  log,
}: ProductApiOptions<S>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!enabled) return json({ error: "not_found" }, 404);

    const product = await authenticate(req.headers.get("authorization"));
    if (!product) {
      log.warn(`${name}.unauthorized`);
      return json({ error: "unauthorized" }, 401);
    }

    const limited = await limit(product);
    if (limited) return limited;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "bad_request", issues: ["$"] }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return json(
        {
          error: "bad_request",
          issues: parsed.error.issues.flatMap((issue) =>
            issue.code === "unrecognized_keys"
              ? issue.keys.map((key) => [...issue.path, key].join("."))
              : [issue.path.join(".") || "$"],
          ),
        },
        400,
      );
    }

    try {
      const result = await run(product, parsed.data);
      log.info(`${name}.done`, {
        product: product.slug,
        status: result.status,
        ...("error" in result ? { error: result.error } : {}),
      });
      return "error" in result
        ? json({ error: result.error }, result.status)
        : json(result.body, 200);
    } catch (err) {
      log.error(`${name}.failed`, {
        product: product.slug,
        errorName: err instanceof Error ? err.name : "unknown",
      });
      return json({ error: "internal_error" }, 500);
    }
  };
}
