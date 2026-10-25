import "server-only";
import { after } from "next/server";
import {
  buildCapture,
  type AnalyticsEventName,
  type AnalyticsProperties,
  type CaptureBase,
} from "@/lib/analytics/events";
import { getRequestContext } from "@/lib/log/context";
import type { Logger } from "@/lib/log/logger";
import { redact } from "@/lib/log/redact";
import { scrubPath } from "@/lib/log/request";

// Takes its configuration as arguments, so it never reads env and tests can
// build one with a fake client. The configured instance lives in
// `@/lib/analytics`.

/** The two PostHog methods used, so tests can pass a fake. */
export interface AnalyticsClient {
  captureImmediate(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): Promise<void>;
  captureExceptionImmediate(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
  ): Promise<void>;
}

export type Schedule = (task: () => Promise<void>) => void;

export interface CaptureErrorContext {
  route?: string;
  path?: string;
  method?: string;
  source: "request" | "better-auth";
}

interface CreateAnalyticsInput {
  client: AnalyticsClient | null;
  env: string;
  log: Logger;
  schedule?: Schedule;
}

// Runs the send after the response when inside a request, so analytics never
// adds latency to an auth response. Outside a request scope `after` throws, and
// the send runs fire-and-forget.
const afterResponse: Schedule = (task) => {
  try {
    after(task);
  } catch {
    void task();
  }
};

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/**
 * A copy of `err` that is safe to send: redacted message and stack, with no
 * cause and none of the own properties a driver error can carry (a Prisma
 * `meta`, for one). Any other thrown value is never stringified.
 */
export function sanitizeError(err: unknown): Error {
  if (!(err instanceof Error)) {
    const clean = new Error("Non-Error thrown");
    clean.name = "NonError";
    return clean;
  }
  const redacted = redact(err) as {
    name: string;
    message: string;
    stack?: string;
  };
  const clean = new Error(redacted.message);
  clean.name = redacted.name;
  clean.stack = redacted.stack;
  return clean;
}

export function createAnalytics({
  client,
  env,
  log,
  schedule = afterResponse,
}: CreateAnalyticsInput) {
  function captureBase(): CaptureBase {
    const requestId = getRequestContext()?.requestId;
    return { sgauth_env: env, ...(requestId ? { request_id: requestId } : {}) };
  }

  return {
    /**
     * Queues one catalog event. Never throws and never blocks: a send that
     * fails is logged by event and error name only, because the error message
     * can echo the request.
     */
    capture<E extends AnalyticsEventName>(
      event: E,
      input: { userId?: string; properties: AnalyticsProperties<E> },
    ): void {
      if (!client) return;
      try {
        const message = buildCapture(event, input, captureBase());
        if (!message) {
          log.warn("analytics.event_rejected", { event });
          return;
        }
        const sender = client;
        schedule(async () => {
          try {
            await sender.captureImmediate(message);
          } catch (err) {
            log.warn("analytics.send_failed", {
              event,
              errName: errorName(err),
            });
          }
        });
      } catch (err) {
        log.warn("analytics.send_failed", { event, errName: errorName(err) });
      }
    },

    /**
     * Sends a sanitized copy of `err` to error tracking. Awaits the send
     * directly: `onRequestError` can run outside a request scope. Never
     * throws.
     */
    async captureError(
      err: unknown,
      context: CaptureErrorContext,
    ): Promise<void> {
      if (!client) return;
      try {
        const requestContext = getRequestContext();
        const userId = requestContext?.userId;
        const base = captureBase();
        const properties: Record<string, unknown> = {
          sgauth_env: base.sgauth_env,
          ...(base.request_id ? { request_id: base.request_id } : {}),
          ...(context.route ? { route: context.route } : {}),
          ...(context.path
            ? { path: scrubPath(context.path.split("?")[0] ?? "") }
            : {}),
          ...(context.method ? { method: context.method } : {}),
          source: context.source,
          ...(userId ? {} : { $process_person_profile: false }),
        };
        await client.captureExceptionImmediate(
          sanitizeError(err),
          userId ?? crypto.randomUUID(),
          properties,
        );
      } catch (sendErr) {
        log.warn("analytics.send_failed", {
          event: "$exception",
          errName: errorName(sendErr),
        });
      }
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;

const silent = () => {};

/**
 * Sends nothing. The default for callers that build auth options without
 * analytics (tests), so importing it never loads the environment.
 */
export const NOOP_ANALYTICS: Analytics = createAnalytics({
  client: null,
  env: "local",
  log: { debug: silent, info: silent, warn: silent, error: silent },
});
