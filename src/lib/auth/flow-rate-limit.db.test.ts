import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { TOO_MANY_REQUESTS_BODY } from "@/lib/rate-limit/limiter";
import {
  STRONG,
  WRONG,
  auditEvents,
  auditEventsByIp,
  createAuthHttpApp,
  ipFor,
} from "@/test/auth-http";
import { useFakeClock, type FakeClock } from "@/test/fake-clock";
import { createUser } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10);
let counter = 0;
const freshEmail = () => `flow-rl-${counter++}-${rand}@northeastern.edu`;

describe("rate limits over HTTP", () => {
  let clock: FakeClock | null = null;
  afterEach(() => {
    clock?.restore();
    clock = null;
  });

  it("answers the 11th sign-in in a minute with 429, then recovers", async () => {
    const app = createAuthHttpApp();
    clock = useFakeClock(new Date());
    // Under five attempts per user, so the account lockout never triggers.
    const users = [
      await createUser({ password: STRONG }),
      await createUser({ password: STRONG }),
      await createUser({ password: STRONG }),
    ];
    for (const [i, attempts] of [4, 3, 3].entries()) {
      for (let n = 0; n < attempts; n++) {
        const { response } = await app.signIn(users[i].email, WRONG);
        expect(response.status).toBe(401);
      }
    }

    const limited = await app.signIn(users[1].email, WRONG);
    expect(limited.response.status).toBe(429);
    expect(await limited.response.json()).toEqual(TOO_MANY_REQUESTS_BODY);
    const retryAfter = limited.response.headers.get("retry-after") ?? "";
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    expect(limited.response.headers.get("cache-control")).toBe("no-store");

    // The handler was never reached, so the refusal left no LOGIN_FAILED row.
    const failures = (await auditEvents(users[1].id)).filter(
      (event) => event.type === "LOGIN_FAILED",
    );
    expect(failures).toHaveLength(3);

    clock.advance(61 * 1000);
    const recovered = await app.signIn(users[2].email, WRONG);
    expect(recovered.response.status).toBe(401);
  });

  it("answers the 6th sign-up from one IP with 429 and creates nothing", async () => {
    const app = createAuthHttpApp();
    const ip = ipFor("signup-limit");
    for (let i = 0; i < 5; i++) await app.signUp(freshEmail(), STRONG, ip);

    const email = freshEmail();
    const limited = await app.request("POST", "/sign-up/email", {
      body: { email, password: STRONG, name: "Flow Test" },
      ip,
    });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(TOO_MANY_REQUESTS_BODY);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await auditEventsByIp(ip, "USER_CREATED")).toHaveLength(5);
  });

  it("limits password reset requests per email, across IPs", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    const statuses: number[] = [];
    for (const label of ["reset-a", "reset-b", "reset-c", "reset-d"]) {
      const response = await app.request("POST", "/request-password-reset", {
        body: { email: user.email },
        ip: ipFor(label),
      });
      statuses.push(response.status);
    }
    await app.drain();

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(
      app.mailer
        .to(user.email)
        .filter((message) => message.template === "reset-password"),
    ).toHaveLength(3);
  });

  it("never consults the limiter for the session endpoint", async () => {
    const backend = {
      limit: vi.fn(async () => ({ success: true, resetMs: Date.now() })),
    };
    const app = createAuthHttpApp({ backend });
    const user = await createUser({ password: STRONG });
    const { response, cookie } = await app.signIn(user.email, STRONG);
    expect(response.status).toBe(200);
    backend.limit.mockClear();

    for (let i = 0; i < 100; i++) {
      expect((await app.getSession(cookie)).status).toBe(200);
    }
    expect(backend.limit).not.toHaveBeenCalled();
  });

  it("fails open, alerting once per rule and leaking no identifier", async () => {
    const backend = { limit: () => Promise.reject(new Error("down")) };
    const app = createAuthHttpApp({ backend });
    const user = await createUser({ password: STRONG });

    for (let i = 0; i < 2; i++) {
      const { response } = await app.signIn(user.email, WRONG);
      expect(response.status).toBe(401);
    }

    expect(app.alerts.map((alert) => alert.msg)).toEqual([
      "[ALERT] rate-limit fail-open",
      "[ALERT] rate-limit fail-open",
    ]);
    expect(app.alerts.map((alert) => alert.fields?.rule).sort()).toEqual([
      "sign-in:ip:1h",
      "sign-in:ip:1m",
    ]);
    const logged = JSON.stringify(app.alerts);
    expect(logged).not.toContain(user.email);
    expect(logged).not.toContain(app.defaultIp);
  });
});
