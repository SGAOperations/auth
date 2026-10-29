import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { STRONG, auditEvents, createAuthHttpApp } from "@/test/auth-http";
import { useFakeClock, type FakeClock } from "@/test/fake-clock";
import { createUser } from "@/test/factories";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("session flows over HTTP", () => {
  let clock: FakeClock | null = null;
  afterEach(() => {
    clock?.restore();
    clock = null;
  });

  async function signedIn(app: ReturnType<typeof createAuthHttpApp>) {
    const user = await createUser({ password: STRONG });
    const { response, cookie } = await app.signIn(user.email, STRONG);
    expect(response.status).toBe(200);
    if (!cookie) throw new Error("sign-in set no session cookie");
    return { user, cookie };
  }

  const countOf = (types: string[], type: string) =>
    types.filter((name) => name === type).length;

  it("slides a used session and expires an untouched one after 30 days", async () => {
    const app = createAuthHttpApp();
    const used = await createUser({ password: STRONG });
    const idle = await createUser({ password: STRONG });
    clock = useFakeClock(new Date());
    const usedCookie = (await app.signIn(used.email, STRONG)).cookie;
    const idleCookie = (await app.signIn(idle.email, STRONG)).cookie;

    clock.advance(29 * DAY_MS);
    expect((await app.getSession(usedCookie)).body).toMatchObject({
      user: { id: used.id },
    });

    clock.advance(2 * DAY_MS);
    expect((await app.getSession(usedCookie)).body).toMatchObject({
      user: { id: used.id },
    });
    expect((await app.getSession(idleCookie)).body).toBeNull();
    const listed = await app.request("GET", "/list-sessions", {
      cookie: idleCookie,
    });
    expect(listed.status).toBe(401);

    for (const user of [used, idle]) {
      const types = (await auditEvents(user.id)).map((event) => event.type);
      expect(countOf(types, "LOGIN_SUCCESS")).toBe(1);
      expect(countOf(types, "LOGOUT")).toBe(0);
    }
  });

  it("never lets a session outlive the 90-day absolute cap", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    clock = useFakeClock(new Date());
    const { cookie } = await app.signIn(user.email, STRONG);
    const initial = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    const cap = initial.absoluteExpiresAt.getTime();
    expect(cap - initial.createdAt.getTime()).toBe(90 * DAY_MS);

    const seen: number[] = [initial.expiresAt.getTime()];
    let elapsed = 0;
    for (const day of [20, 40, 60, 80, 89]) {
      clock.advance((day - elapsed) * DAY_MS);
      elapsed = day;
      expect((await app.getSession(cookie)).body).toMatchObject({
        user: { id: user.id },
      });
      const row = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(cap);
      seen.push(row.expiresAt.getTime());
    }
    // Slid forward while there was room, and ended pinned at the cap.
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen.every((at, i) => i === 0 || at >= seen[i - 1])).toBe(true);
    expect(seen.at(-1)).toBe(cap);

    clock.advance(DAY_MS + HOUR_MS);
    expect((await app.getSession(cookie)).body).toBeNull();
    const listed = await app.request("GET", "/list-sessions", { cookie });
    expect(listed.status).toBe(401);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("signs out one session and leaves the user's others", async () => {
    const app = createAuthHttpApp();
    const { user, cookie: a } = await signedIn(app);
    const other = await app.signIn(user.email, STRONG);
    const b = other.cookie;

    const current = (await app.getSession(a)).body as {
      session: { id: string };
    };
    const sessionId = current.session.id;

    const out = await app.request("POST", "/sign-out", { cookie: a });
    expect(out.status).toBe(200);

    expect(await prisma.session.findUnique({ where: { id: sessionId } })).toBe(
      null,
    );
    expect((await app.getSession(a)).body).toBeNull();
    expect((await app.getSession(b)).body).toMatchObject({
      user: { id: user.id },
    });

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "LOGIN_SUCCESS",
      "LOGIN_SUCCESS",
      "LOGOUT",
    ]);
    expect(events[2]).toMatchObject({
      targetType: "SESSION",
      targetId: sessionId,
    });
  });

  it("signs out everywhere", async () => {
    const app = createAuthHttpApp();
    const { user, cookie: a } = await signedIn(app);
    const b = (await app.signIn(user.email, STRONG)).cookie;
    const c = (await app.signIn(user.email, STRONG)).cookie;

    // Run on real time right after sign-in: the endpoint needs a fresh session.
    const out = await app.request("POST", "/revoke-sessions", { cookie: a });
    expect(out.status).toBe(200);

    for (const cookie of [a, b, c]) {
      expect((await app.getSession(cookie)).body).toBeNull();
    }
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "LOGIN_SUCCESS",
      "LOGIN_SUCCESS",
      "LOGIN_SUCCESS",
      "SESSIONS_REVOKED",
    ]);
    expect(events[3].metadata).toEqual({ scope: "all" });
  });
});
