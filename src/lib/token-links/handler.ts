import "server-only";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import { safeNextPath } from "@/lib/preview-gate";
import type { CheckResult } from "@/lib/rate-limit/limiter";
import { requestOrigin } from "@/lib/request-origin";
import { TOKEN_ACTIONS, type TokenActionName } from "@/lib/token-links/actions";

/** The `?result=` values a token-link page renders. */
export const TOKEN_ACTION_RESULTS = [
  "done",
  "invalid",
  "used",
  "rate",
  "sent",
  "error",
] as const;

export type TokenActionResult = (typeof TOKEN_ACTION_RESULTS)[number];

/**
 * What a page's `consume` reports. Its single-use guard must be atomic, the
 * way `consumeUnlockToken`'s conditional update and `claimVerifyToken`'s
 * conflict-free insert are. A store that cannot tell "used" from "unknown"
 * returns `invalid`.
 */
export type TokenActionOutcome =
  | { result: "done"; headers?: Headers; redirectTo?: string }
  | { result: "invalid" }
  // The token was valid but already used; nothing ran.
  | { result: "used" }
  // A resend POST: a new link was requested, whether or not one went out.
  | { result: "sent" }
  // A per-account limit, on top of the IP limit, stopped the request.
  | { result: "rate" }
  // Back to the form with the token, for example a weak new password.
  | { result: "retry"; error: string };

export interface TokenActionInput {
  token: string;
  fields: Record<string, unknown>;
  request: Request;
}

export interface TokenActionLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface TokenActionHandlerOptions {
  action: TokenActionName;
  /** Extra form fields beyond `token`, such as a new password. */
  fields?: z.ZodObject;
  consume: (input: TokenActionInput) => Promise<TokenActionOutcome>;
  /** Keyed on the client IP. */
  limit: (ip: string) => Promise<CheckResult>;
  /**
   * Whether a `done` outcome's `redirectTo` may be followed. The default is a
   * path on this origin; a page that sends people on to a registered product
   * passes the check that also admits that product's origin.
   */
  allowRedirect?: (target: string) => boolean | Promise<boolean>;
  log: TokenActionLog;
  /**
   * The one origin a POST may come from: the configured auth base URL's
   * origin. The default is the request URL's origin, which is wrong behind a
   * dev server whose `request.url` is `http://localhost:3000` while the browser
   * is on `http://auth.sga.localhost:3000`.
   */
  ownOrigin?: string;
}

const isSameOriginPath = (target: string) => safeNextPath(target) === target;

const tokenSchema = z.string().min(1).max(4096);

const NO_STORE = { "Cache-Control": "no-store" };

function redirect(location: URL, cookies: readonly string[] = []): Response {
  const headers = new Headers(NO_STORE);
  headers.set("Location", location.toString());
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * The POST half of a scanner-safe emailed link. The page renders a form, and
 * this is the only place the token is consumed.
 */
export function createTokenActionHandler({
  action,
  fields,
  consume,
  limit,
  allowRedirect = isSameOriginPath,
  log,
  ownOrigin,
}: TokenActionHandlerOptions): (request: Request) => Promise<Response> {
  const { path } = TOKEN_ACTIONS[action];
  const formSchema = z
    .object({ token: tokenSchema })
    .extend(fields?.shape ?? {});

  return async function handle(request) {
    if (requestOrigin(request) !== (ownOrigin ?? new URL(request.url).origin)) {
      return new Response(null, { status: 403, headers: NO_STORE });
    }

    const back = (params: Record<string, string>) => {
      const target = new URL(path, request.url);
      for (const [key, value] of Object.entries(params)) {
        target.searchParams.set(key, value);
      }
      return target;
    };

    const rate = await limit(clientIp(request.headers));
    if (!rate.allowed) return redirect(back({ result: "rate" }));

    // formData() throws on a non-form Content-Type or a malformed body.
    const form = await request.formData().catch(() => null);
    if (!form) return redirect(back({ result: "invalid" }));

    const raw: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") raw[key] = value;
    }

    const parsed = formSchema.safeParse(raw);
    if (!parsed.success) {
      const token = tokenSchema.safeParse(raw.token);
      return redirect(
        token.success
          ? back({ token: token.data, error: "fields" })
          : back({ result: "invalid" }),
      );
    }
    const { token, ...rest } = parsed.data as { token: string } & Record<
      string,
      unknown
    >;

    let outcome: TokenActionOutcome;
    try {
      outcome = await consume({ token, fields: rest, request });
    } catch (error) {
      // Never the token, and never the message, which could carry it.
      log.error("token_link_failed", {
        action,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return redirect(back({ result: "error" }));
    }

    switch (outcome.result) {
      case "done": {
        const target =
          outcome.redirectTo !== undefined &&
          (await allowRedirect(outcome.redirectTo))
            ? new URL(outcome.redirectTo, request.url)
            : back({ result: "done" });
        return redirect(target, outcome.headers?.getSetCookie() ?? []);
      }
      case "used":
      case "sent":
      case "rate":
        return redirect(back({ result: outcome.result }));
      case "retry":
        return redirect(back({ token, error: outcome.error }));
      case "invalid":
        return redirect(back({ result: "invalid" }));
    }
  };
}
