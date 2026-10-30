import { afterEach, describe, expect, it, vi } from "vitest";
import { audit } from "@/lib/audit";
import { createUnlockConsumer } from "@/lib/auth/unlock";
import { prisma } from "@/lib/prisma";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import {
  BASE_URL,
  STRONG,
  WRONG,
  auditEvents,
  createAuthHttpApp,
  type AuthHttpApp,
} from "@/test/auth-http";
import { useFakeClock, type FakeClock } from "@/test/fake-clock";
import { createUser } from "@/test/factories";

const MINUTE_MS = 60 * 1000;

// Built the way src/app/unlock/confirm/route.ts builds it. The route module is
// not imported: it would parse the full app env through `@/lib/env`.
const confirmUnlock = createTokenActionHandler({
  action: "account-unlock",
  consume: createUnlockConsumer({
    prisma,
    onUnlocked: async (tx, userId) => {
      await audit(
        {
          type: "ACCOUNT_UNLOCKED",
          actorType: "USER",
          actorUserId: userId,
          targetType: "USER",
          targetId: userId,
          metadata: { method: "email_link" },
        },
        { db: tx },
      );
    },
  }),
  limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  log: { error: vi.fn() },
});

function postConfirm(token: string) {
  return confirmUnlock(
    new Request(`${BASE_URL}/unlock/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
      },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
}

const resultOf = (response: Response) =>
  new URL(response.headers.get("location") ?? "").searchParams.get("result");

function unlockTokenFor(app: AuthHttpApp, email: string): string {
  const sent = app.mailer
    .to(email)
    .filter((message) => message.template === "account-unlock")
    .at(-1);
  const link = new URL(String(sent?.data.url));
  expect(link.pathname).toBe("/unlock");
  return link.searchParams.get("token") ?? "";
}

async function failTimes(app: AuthHttpApp, email: string, times: number) {
  for (let i = 0; i < times; i++) {
    const { response } = await app.signIn(email, WRONG);
    expect(response.status).toBe(401);
  }
}

describe("account lockout over HTTP", () => {
  let clock: FakeClock | null = null;
  afterEach(() => {
    clock?.restore();
    clock = null;
  });

  it("locks on the sixth attempt, mails an unlock link, and unlocks once", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });

    const first = await app.signIn(user.email, WRONG);
    const wrongBody = await first.response.json();
    expect(first.response.status).toBe(401);
    await failTimes(app, user.email, 4);

    const refused = await app.signIn(user.email, STRONG);
    expect(refused.response.status).toBe(401);
    expect(await refused.response.json()).toEqual(wrongBody);

    await app.drain();
    const templates = app.mailer.to(user.email).map((m) => m.template);
    expect(templates.filter((name) => name === "account-locked")).toHaveLength(
      1,
    );
    expect(templates.filter((name) => name === "account-unlock")).toHaveLength(
      1,
    );

    const token = unlockTokenFor(app, user.email);
    const unlocked = await postConfirm(token);
    expect(unlocked.status).toBe(303);
    expect(resultOf(unlocked)).toBe("done");

    const signedIn = await app.signIn(user.email, STRONG);
    expect(signedIn.response.status).toBe(200);
    expect(resultOf(await postConfirm(token))).toBe("invalid");

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "ACCOUNT_LOCKED",
      "LOGIN_FAILED",
      "ACCOUNT_UNLOCKED",
      "LOGIN_SUCCESS",
    ]);
    for (const event of events.slice(0, 5)) {
      expect(event.metadata).toEqual({ reason: "INVALID_EMAIL_OR_PASSWORD" });
    }
    expect(events[5].metadata).toEqual({ lockLevel: 1, durationMinutes: 15 });
    expect(events[6].metadata).toEqual({ reason: "ACCOUNT_LOCKED" });
    expect(events[7].metadata).toEqual({ method: "email_link" });
  });

  it("escalates the second lock to 30 minutes after the first expires", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    clock = useFakeClock(new Date());

    await failTimes(app, user.email, 5);
    clock.advance(16 * MINUTE_MS);
    const recovered = await app.signIn(user.email, STRONG);
    expect(recovered.response.status).toBe(200);

    await failTimes(app, user.email, 5);
    await app.drain();

    // Under a frozen clock rows can share a timestamp, so compare the locks
    // by level rather than by their position in the log.
    const locks = (await auditEvents(user.id))
      .filter((event) => event.type === "ACCOUNT_LOCKED")
      .map((event) => event.metadata as Record<string, number>)
      .sort((a, b) => a.lockLevel - b.lockLevel);
    expect(locks).toEqual([
      { lockLevel: 1, durationMinutes: 15 },
      { lockLevel: 2, durationMinutes: 30 },
    ]);
  });

  it("treats an unknown email like a wrong password and sends nothing", async () => {
    const app = createAuthHttpApp();
    const email = `nobody-lockout-${Math.random().toString(36).slice(2, 10)}@northeastern.edu`;

    const bodies: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const { response } = await app.signIn(email, WRONG);
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    await app.drain();

    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(app.mailer.sent).toHaveLength(0);
  });
});
