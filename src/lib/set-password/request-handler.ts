import "server-only";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import { normalizeEmail } from "@/lib/auth/policy";
import { tooManyRequests, type CheckResult } from "@/lib/rate-limit/limiter";
import { requestOrigin } from "@/lib/request-origin";
import type { SetPasswordService } from "@/lib/set-password/service";

// The two ways to ask for a set-password link: the login page's email step
// (JSON) and the expired-link page's form. Both answer the same for every
// well-formed address, whether or not it exists, has a password, is
// deactivated or is over its limit, and they answer before any of that is
// looked up: the lookup, the token and the email run after the response.

export type SetPasswordRequestMode = "json" | "form";

const NO_STORE = { "Cache-Control": "no-store" };

const bodySchema = z.strictObject({ email: z.email().max(320) });

export interface SetPasswordRequestLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface SetPasswordRequestHandlerOptions {
  mode: SetPasswordRequestMode;
  service: Pick<SetPasswordService, "requestLink">;
  /** The `setPasswordRequest` policy, keyed on the IP and the email. */
  limit: (ids: { ip: string; email: string }) => Promise<CheckResult>;
  /** Runs a task after the response: Next's `after`. Tests pass a collector. */
  defer: (task: () => Promise<void>) => void;
  log: SetPasswordRequestLog;
  /**
   * The origin the browser sends, from the configured auth base URL. The
   * default is the request URL's origin, which is wrong behind a dev server
   * whose `request.url` is `http://localhost:3000` while the browser is on
   * `http://auth.sga.localhost:3000`.
   */
  ownOrigin?: string;
}

function redirect(request: Request, result: string): Response {
  const target = new URL("/set-password", request.url);
  target.searchParams.set("result", result);
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: target.toString() },
  });
}

async function readBody(
  request: Request,
  mode: SetPasswordRequestMode,
): Promise<unknown> {
  if (mode === "json") return request.json().catch(() => null);
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const raw: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    raw[key] = typeof value === "string" ? value : null;
  }
  return raw;
}

export function createSetPasswordRequestHandler({
  mode,
  service,
  limit,
  defer,
  log,
  ownOrigin,
}: SetPasswordRequestHandlerOptions): (request: Request) => Promise<Response> {
  const via = mode === "json" ? "sign_in" : "link_request";

  return async function handle(request) {
    if (requestOrigin(request) !== (ownOrigin ?? new URL(request.url).origin)) {
      return new Response(null, { status: 403, headers: NO_STORE });
    }

    const parsed = bodySchema.safeParse(await readBody(request, mode));
    if (!parsed.success) {
      // About the input's shape, so it reveals nothing about any account.
      return mode === "json"
        ? Response.json(
            { code: "INVALID_EMAIL", message: "Enter a valid email address." },
            { status: 400, headers: NO_STORE },
          )
        : redirect(request, "invalid-email");
    }
    const email = normalizeEmail(parsed.data.email);

    // Per-email buckets count a request whether or not the account exists.
    const rate = await limit({ ip: clientIp(request.headers), email });
    if (!rate.allowed) {
      return mode === "json"
        ? tooManyRequests(rate.retryAfterSeconds)
        : redirect(request, "rate");
    }

    defer(() =>
      service.requestLink({ email, via }).catch((error: unknown) => {
        // Never the email or the message, which could carry it.
        log.error("set_password_request_failed", {
          via,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }),
    );

    return mode === "json"
      ? Response.json({ ok: true }, { status: 200, headers: NO_STORE })
      : redirect(request, "sent");
  };
}
