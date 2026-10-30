import { randomInt } from "node:crypto";
import { betterAuth } from "better-auth";
import { prisma } from "@/lib/prisma";
import {
  buildCookieOptions,
  deviceCookieName,
  resolveCookiePolicy,
  sessionCookieName,
} from "@/lib/auth/cookies";
import { buildAuthOptions } from "@/lib/auth/options";
import { createAuthRouteLimiter } from "@/lib/rate-limit/auth-route";
import {
  createRateLimiter,
  type RateLimitBackend,
} from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { createVerifyEmailConsumer } from "@/lib/token-links/verify-email";
import { createCapturingMailer } from "@/test/capturing-mailer";

export const BASE_URL = "http://auth.sga.localhost:3000";
export const SECRET = "s".repeat(32);
export const STRONG = "correct-horse-battery-staple";
export const WRONG = "not-the-right-password";

const cookies = resolveCookiePolicy("local");
const SESSION_COOKIE = sessionCookieName(cookies);

// Random per process, so a rerun against the same branch never reuses an IP
// that an earlier run left in the append-only audit log.
const ipPrefix = `10.${randomInt(1, 255)}.${randomInt(0, 256)}`;
const ips = new Map<string, string>();

/** A unique, stable test IP for `label` within this process. */
export function ipFor(label: string): string {
  let ip = ips.get(label);
  if (!ip) {
    if (ips.size >= 254) throw new Error("out of test IPs");
    ip = `${ipPrefix}.${ips.size + 1}`;
    ips.set(label, ip);
  }
  return ip;
}

/** `name=value` of the session cookie a response sets, or `null`. */
export function cookieOf(response: Response): string | null {
  return cookieFromHeaders(response.headers);
}

function cookieFromHeaders(headers: Headers): string | null {
  const entry = headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  // A value-less pair is the expiry of a cleared cookie.
  return entry && !entry.endsWith("=") ? entry : null;
}

export interface RequestOptions {
  body?: unknown;
  cookie?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

export interface AlertRecord {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

let appCounter = 0;

/**
 * The auth stack behind `src/app/api/auth/[...all]/route.ts`, minus request
 * logging: the real `buildAuthOptions`, the local cookie policy, a capturing
 * mailer, and the route limiter over an in-memory backend. Every request is a
 * real `Request` through `handle`.
 */
export function createAuthHttpApp({
  backend = createMemoryBackend({ now: () => Date.now() }),
}: { backend?: RateLimitBackend } = {}) {
  const mailer = createCapturingMailer();
  const pending: Promise<unknown>[] = [];
  const alerts: AlertRecord[] = [];
  const defaultIp = ipFor(`app-${appCounter++}`);

  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [BASE_URL],
      advanced: {
        ...buildCookieOptions(cookies),
        backgroundTasks: {
          handler: (task) => {
            pending.push(task);
          },
        },
      },
      lockout: {
        mailer,
        deviceCookie: { name: deviceCookieName(cookies), secure: false },
        defer: (task) => task(),
      },
    }),
    rateLimit: { enabled: false },
  });

  // Arrow functions, never a bare `Date.now`: a captured reference would
  // bypass `useFakeClock`, which is installed after this runs.
  const limiter = createRateLimiter({
    backend,
    log: {
      error: (msg, fields) => {
        alerts.push({ msg, fields });
      },
    },
    now: () => Date.now(),
  });
  const handle = createAuthRouteLimiter({
    limiter,
    sessionCookieName: SESSION_COOKIE,
  })(auth.handler);

  function request(
    method: "GET" | "POST",
    path: string,
    { body, cookie, ip = defaultIp, headers }: RequestOptions = {},
  ): Promise<Response> {
    return handle(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method,
        headers: {
          origin: BASE_URL,
          "x-forwarded-for": ip,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      }),
    );
  }

  /** Awaits the background tasks Better Auth deferred (mail, some audits). */
  async function drain() {
    await Promise.all(pending.splice(0));
  }

  async function signUp(email: string, password = STRONG, ip?: string) {
    const response = await request("POST", "/sign-up/email", {
      body: { email, password, name: "Flow Test" },
      ip,
    });
    if (response.status !== 200) {
      throw new Error(`sign-up answered ${response.status}`);
    }
    return response;
  }

  /**
   * Confirms the address behind the newest emailed verify link, as the
   * confirm POST does, and returns the session cookie the auto sign-in sets.
   */
  async function verify(email: string): Promise<string | null> {
    const message = mailer
      .to(email)
      .filter((sent) => sent.template === "verify-email")
      .at(-1);
    const token = new URL(String(message?.data.url)).searchParams.get("token");
    if (!token) throw new Error("no verify token in the emailed link");
    const outcome = await createVerifyEmailConsumer({
      auth,
      db: prisma,
      secret: SECRET,
      resolveRedirect: async () => "/",
    })({
      token,
      fields: {},
      request: new Request(`${BASE_URL}/verify-email/confirm`, {
        method: "POST",
        headers: { origin: BASE_URL, "x-forwarded-for": defaultIp },
      }),
    });
    if (outcome.result !== "done") {
      throw new Error(`verify answered ${outcome.result}`);
    }
    return outcome.headers ? cookieFromHeaders(outcome.headers) : null;
  }

  async function signIn(
    email: string,
    password: string,
    options: Omit<RequestOptions, "body"> = {},
  ) {
    const response = await request("POST", "/sign-in/email", {
      ...options,
      body: { email, password },
    });
    return { response, cookie: cookieOf(response) };
  }

  /** The session behind `cookie`, or `null`; the raw response is returned too. */
  async function getSession(cookie: string | null, ip?: string) {
    const response = await request("GET", "/get-session", { cookie, ip });
    const text = await response.text();
    return {
      response,
      status: response.status,
      body: text ? (JSON.parse(text) as unknown) : null,
    };
  }

  return {
    auth,
    mailer,
    alerts,
    defaultIp,
    request,
    drain,
    signUp,
    verify,
    signIn,
    getSession,
  };
}

export type AuthHttpApp = ReturnType<typeof createAuthHttpApp>;

/**
 * Audit rows the user acted in or was the target of, oldest first. The log is
 * append-only and never reset, so tests use a fresh user each and read only
 * that user's rows.
 */
export function auditEvents(userId: string) {
  return prisma.auditEvent.findMany({
    where: { OR: [{ targetId: userId }, { actorUserId: userId }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function auditTypes(userId: string): Promise<string[]> {
  return (await auditEvents(userId)).map((event) => event.type);
}

/** Rows of one type written for requests from `ip` (for an unknown user). */
export function auditEventsByIp(ip: string, type: string) {
  return prisma.auditEvent.findMany({ where: { ip, type } });
}
