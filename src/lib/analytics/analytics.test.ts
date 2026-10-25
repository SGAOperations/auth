import { describe, expect, it, vi } from "vitest";
import {
  createAnalytics,
  sanitizeError,
  type AnalyticsClient,
  type Schedule,
} from "@/lib/analytics/analytics";
import { runWithRequestContext } from "@/lib/log/context";
import type { Logger } from "@/lib/log/logger";

const USER_ID = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";

function fakeClient(overrides: Partial<AnalyticsClient> = {}) {
  const captured: Parameters<AnalyticsClient["captureImmediate"]>[0][] = [];
  const exceptions: {
    error: unknown;
    distinctId?: string;
    properties?: Record<string, unknown>;
  }[] = [];
  const client: AnalyticsClient = {
    captureImmediate: async (message) => {
      captured.push(message);
    },
    captureExceptionImmediate: async (error, distinctId, properties) => {
      exceptions.push({ error, distinctId, properties });
    },
    ...overrides,
  };
  return { client, captured, exceptions };
}

function fakeLog() {
  const calls: { level: string; msg: string; fields?: unknown }[] = [];
  const record = (level: string) => (msg: string, fields?: unknown) => {
    calls.push({ level, msg, fields });
  };
  const log: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return { log, calls };
}

// Runs the task at once and lets the test await it.
function syncSchedule() {
  const pending: Promise<void>[] = [];
  const schedule: Schedule = (task) => {
    pending.push(task());
  };
  return { schedule, settle: () => Promise.all(pending) };
}

function build(client: AnalyticsClient | null) {
  const { log, calls } = fakeLog();
  const { schedule, settle } = syncSchedule();
  const analytics = createAnalytics({ client, env: "dev", log, schedule });
  return { analytics, calls, settle };
}

describe("capture", () => {
  it("makes no calls without a client", async () => {
    const { analytics, settle } = build(null);
    analytics.capture("signup_started", { userId: USER_ID, properties: {} });
    await settle();
  });

  it("sends a catalog event with the environment and request id", async () => {
    const { client, captured } = fakeClient();
    const { analytics, settle } = build(client);
    runWithRequestContext(
      { requestId: "req-9", route: "/r", method: "POST", path: "/p" },
      () =>
        analytics.capture("login_succeeded", {
          userId: USER_ID,
          properties: { method: "password" },
        }),
    );
    await settle();
    expect(captured).toEqual([
      {
        distinctId: USER_ID,
        event: "login_succeeded",
        properties: {
          method: "password",
          sgauth_env: "dev",
          request_id: "req-9",
        },
      },
    ]);
  });

  it("logs a rejected event and sends nothing", async () => {
    const { client, captured } = fakeClient();
    const { analytics, calls, settle } = build(client);
    analytics.capture("login_failed", {
      // @ts-expect-error deliberately outside the catalog
      properties: { reason: "OTHER", email: "x@northeastern.edu" },
    });
    await settle();
    expect(captured).toEqual([]);
    expect(calls).toEqual([
      {
        level: "warn",
        msg: "analytics.event_rejected",
        fields: { event: "login_failed" },
      },
    ]);
  });

  it("never propagates a rejecting client and never logs its message", async () => {
    const { client } = fakeClient({
      captureImmediate: async () => {
        throw new TypeError("connect ECONNREFUSED leak@northeastern.edu");
      },
    });
    const { analytics, calls, settle } = build(client);
    analytics.capture("signup_started", { userId: USER_ID, properties: {} });
    await settle();
    expect(calls).toEqual([
      {
        level: "warn",
        msg: "analytics.send_failed",
        fields: { event: "signup_started", errName: "TypeError" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("leak@");
  });

  it("never propagates a client that throws synchronously", async () => {
    const { client } = fakeClient({
      captureImmediate: () => {
        throw new Error("boom");
      },
    });
    const { analytics, calls, settle } = build(client);
    expect(() =>
      analytics.capture("signup_started", { userId: USER_ID, properties: {} }),
    ).not.toThrow();
    await settle();
    expect(calls[0]?.msg).toBe("analytics.send_failed");
  });

  it("never propagates a throwing scheduler", () => {
    const { client } = fakeClient();
    const { log, calls } = fakeLog();
    const analytics = createAnalytics({
      client,
      env: "dev",
      log,
      schedule: () => {
        throw new Error("no scheduler");
      },
    });
    expect(() =>
      analytics.capture("signup_started", { userId: USER_ID, properties: {} }),
    ).not.toThrow();
    expect(calls[0]?.msg).toBe("analytics.send_failed");
  });

  it("falls back to a direct send outside a request scope", async () => {
    const { client, captured } = fakeClient();
    const { log } = fakeLog();
    // The default scheduler: `after` throws here, so the task runs directly.
    const analytics = createAnalytics({ client, env: "dev", log });
    analytics.capture("signup_started", { userId: USER_ID, properties: {} });
    await vi.waitFor(() => expect(captured).toHaveLength(1));
  });
});

describe("captureError", () => {
  it("sends a redacted error with no cause", async () => {
    const { client, exceptions } = fakeClient();
    const { analytics } = build(client);
    const err = new Error("failed for person@northeastern.edu", {
      cause: new Error("inner secret"),
    });
    await analytics.captureError(err, { source: "better-auth" });
    const sent = exceptions[0]?.error as Error;
    expect(sent.message).toBe("failed for [REDACTED_EMAIL]");
    expect(sent.cause).toBeUndefined();
    expect(sent.stack).not.toContain("person@");
  });

  it("sends the request user id when there is one", async () => {
    const { client, exceptions } = fakeClient();
    const { analytics } = build(client);
    await runWithRequestContext(
      {
        requestId: "req-1",
        route: "/r",
        method: "GET",
        path: "/p",
        userId: USER_ID,
      },
      () => analytics.captureError(new Error("x"), { source: "request" }),
    );
    expect(exceptions[0]?.distinctId).toBe(USER_ID);
    expect(exceptions[0]?.properties).toEqual({
      sgauth_env: "dev",
      request_id: "req-1",
      source: "request",
    });
  });

  it("is anonymous without a user", async () => {
    const { client, exceptions } = fakeClient();
    const { analytics } = build(client);
    await analytics.captureError(new Error("x"), { source: "request" });
    expect(exceptions[0]?.distinctId).toMatch(/^[0-9a-f-]{36}$/);
    expect(exceptions[0]?.properties?.$process_person_profile).toBe(false);
  });

  it("drops the query string and scrubs token path segments", async () => {
    const { client, exceptions } = fakeClient();
    const { analytics } = build(client);
    await analytics.captureError(new Error("x"), {
      source: "request",
      route: "/api/auth/[...all]",
      method: "GET",
      path: "/api/auth/reset-password/SENTINEL?token=SENTINEL",
    });
    const properties = exceptions[0]?.properties;
    expect(properties?.path).toBe("/api/auth/reset-password/[REDACTED]");
    expect(JSON.stringify(properties)).not.toContain("SENTINEL");
    expect(properties?.route).toBe("/api/auth/[...all]");
    expect(properties?.method).toBe("GET");
  });

  it("hands the send to the scheduler only when deferred", async () => {
    const { client, exceptions } = fakeClient();
    const { log } = fakeLog();
    const queued: (() => Promise<void>)[] = [];
    const analytics = createAnalytics({
      client,
      env: "dev",
      log,
      schedule: (task) => {
        queued.push(task);
      },
    });
    await analytics.captureError(
      new Error("x"),
      { source: "better-auth" },
      {
        defer: true,
      },
    );
    expect(exceptions).toHaveLength(0);
    expect(queued).toHaveLength(1);
    await queued[0]?.();
    expect(exceptions).toHaveLength(1);

    await analytics.captureError(new Error("y"), { source: "request" });
    expect(queued).toHaveLength(1);
    expect(exceptions).toHaveLength(2);
  });

  it("makes no calls without a client", async () => {
    const { analytics } = build(null);
    await expect(
      analytics.captureError(new Error("x"), { source: "request" }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the client rejects", async () => {
    const { client } = fakeClient({
      captureExceptionImmediate: async () => {
        throw new Error("down");
      },
    });
    const { analytics, calls } = build(client);
    await expect(
      analytics.captureError(new Error("x"), { source: "request" }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.msg).toBe("analytics.send_failed");
  });
});

describe("sanitizeError", () => {
  it("turns a non-Error value into NonError without stringifying it", () => {
    const sent = sanitizeError({ email: "person@northeastern.edu" });
    expect(sent.name).toBe("NonError");
    expect(sent.message).toBe("Non-Error thrown");
    expect(JSON.stringify([sent.message, sent.stack])).not.toContain("person@");
  });

  it("drops own properties such as a driver's meta", () => {
    const err = Object.assign(new Error("x"), { meta: { target: "email" } });
    expect(Object.keys(sanitizeError(err))).not.toContain("meta");
  });

  it("keeps the error name", () => {
    expect(sanitizeError(new RangeError("x")).name).toBe("RangeError");
  });
});
