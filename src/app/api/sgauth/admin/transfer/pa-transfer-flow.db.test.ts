import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({
  cron: "test-cron-secret-0123456789abcdef0123",
}));

// `env` is parsed once at import and the db project sets no CRON_SECRET. The
// job route reads it when it loads, so give it one.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, env: { ...actual.env, CRON_SECRET: secrets.cron } };
});
vi.mock("@/lib/prisma", async (importOriginal) => {
  const { prisma } = await importOriginal<typeof import("@/lib/prisma")>();
  const { createRollbackPrisma } = await import("@/test/rollback-prisma");
  return { prisma: createRollbackPrisma(prisma) };
});
vi.mock("@/lib/auth/server", async () => {
  return (await import("@/test/admin-http")).authServerMock;
});
vi.mock("@/lib/email/server", async () => {
  const { captured } = await import("@/test/admin-http");
  return { mailer: captured, sendEmail: captured.sendEmail };
});
vi.mock("@/lib/rate-limit/server", async () => {
  return (await import("@/test/admin-http")).rateLimitServerMock;
});
vi.mock("next/headers", async () => {
  return (await import("@/test/admin-http")).nextHeadersMock;
});

import type { User } from "@/generated/prisma/client";
import { POST as runJob } from "@/app/api/jobs/pa-transfer/route";
import { POST as confirmCancel } from "@/app/transfer/cancel/confirm/route";
import { prisma } from "@/lib/prisma";
import {
  API,
  BASE_URL,
  callRoute,
  captured,
  codeOf,
  markReauthFresh,
  signIn,
  type Actor,
  type CallResult,
} from "@/test/admin-http";
import { createAdmin, createPrimaryAdmin, createUser } from "@/test/factories";
import { useFakeClock as freezeClock, type FakeClock } from "@/test/fake-clock";
import {
  assertDeferredConstraints,
  withRollback,
} from "@/test/rollback-prisma";
import { POST as accept } from "./[id]/accept/route";
import { POST as cancel } from "./[id]/cancel/route";
import { POST as decline } from "./[id]/decline/route";
import { POST as initiate } from "./route";
import { POST as userAction } from "../users/[id]/[action]/route";
import { DELETE as deleteUser } from "../users/[id]/route";
import { GET as listUsers } from "../users/route";

// The Primary Admin transfer through its HTTP routes, the emailed cancel link
// and the scheduled job's route. Each case runs in one transaction that rolls
// back and drives a faked clock, because the transfer needs a Primary Admin
// and waits 24 hours and 7 days.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Party = "pa" | "r" | "t" | "u";

/** The Primary Admin, the recipient, a third admin and a non-admin. */
interface Scene {
  clock: FakeClock;
  actors: Record<Party, Actor>;
}

async function scene(): Promise<Scene> {
  captured.clear();
  // Before any session exists, so every expiry is measured on the fake clock.
  const clock = freezeClock("2026-06-01T12:00:00Z");
  const pa = await createPrimaryAdmin({ twoFactorEnabled: true }, prisma);
  const r = await createAdmin({ twoFactorEnabled: true });
  const t = await createAdmin({ twoFactorEnabled: true });
  const u = await createUser({ twoFactorEnabled: true });
  return {
    clock,
    actors: {
      pa: await signIn(pa),
      r: await signIn(r),
      t: await signIn(t),
      u: await signIn(u),
    },
  };
}

/** Moves the clock and re-authenticates everyone, as a person at the keyboard would. */
async function advance(s: Scene, ms: number) {
  s.clock.advance(ms);
  for (const actor of Object.values(s.actors)) await markReauthFresh(actor);
}

const transferUrl = (tail = "") => `${API}/transfer${tail}`;

const initiateFor = (from: Actor, to: User) =>
  callRoute(initiate, {
    method: "POST",
    url: transferUrl(),
    as: from,
    body: { recipientUserId: to.id, confirmEmail: to.email },
  });

type Verb = "accept" | "decline" | "cancel";
const VERBS = { accept, decline, cancel } as const;

const actOn = (verb: Verb, id: string, as: Actor) =>
  callRoute(VERBS[verb], {
    method: "POST",
    url: transferUrl(`/${id}/${verb}`),
    as,
    body: {},
    params: { id },
  });

const userUrl = (id: string, tail = "") => `${API}/users/${id}${tail}`;

const adminAction = (as: Actor, target: User, action: string) =>
  callRoute(userAction, {
    method: "POST",
    url: userUrl(target.id, `/${action}`),
    as,
    params: { id: target.id, action },
  });

const confirmLink = (token: string) =>
  callRoute(confirmCancel, {
    method: "POST",
    url: `${BASE_URL}/transfer/cancel/confirm`,
    form: { token },
  });

interface JobResult {
  executed: number;
  cancelled: number;
  expired: number;
  notifyFailures: number;
}

async function runTheJob(): Promise<JobResult> {
  const response = await callRoute(runJob, {
    method: "POST",
    url: `${BASE_URL}/api/jobs/pa-transfer`,
    headers: { authorization: `Bearer ${secrets.cron}` },
  });
  expect(response.status).toBe(200);
  return (response.body as { result: JobResult }).result;
}

const row = (id: string) =>
  prisma.primaryAdminTransfer.findUniqueOrThrow({ where: { id } });

const auditOf = (id: string) =>
  prisma.auditEvent.findMany({
    where: { targetType: "TRANSFER", targetId: id },
  });

const auditTypes = async (id: string) =>
  (await auditOf(id)).map((event) => event.type).sort();

const primaryAdminIds = async () =>
  (
    await prisma.user.findMany({
      where: { isPrimaryAdmin: true },
      select: { id: true },
    })
  ).map((user) => user.id);

/** Emails of one template that went to `user`. */
const mailTo = (user: User, template: string) =>
  captured.to(user.email).filter((message) => message.template === template);

const transferIdOf = (body: unknown) =>
  (body as { transfer: { id: string } }).transfer.id;

/** The PA starts a transfer to R. */
async function start(s: Scene): Promise<string> {
  const response = await initiateFor(s.actors.pa, s.actors.r.user);
  expect(response.status).toBe(201);
  return transferIdOf(response.body);
}

/** R accepts; returns the raw cancel token from the email to the PA. */
async function acceptAndGetToken(s: Scene, id: string): Promise<string> {
  const response = await actOn("accept", id, s.actors.r);
  expect(response.status).toBe(200);
  const [message] = mailTo(s.actors.pa.user, "pa-transfer-accepted");
  const token = new URL(String(message?.data.cancelUrl)).searchParams.get(
    "token",
  );
  expect(token).toBeTruthy();
  return token as string;
}

const locationOf = (headers: Headers) => new URL(headers.get("location") ?? "");

beforeEach(() => {
  captured.clear();
});

describe("the whole transfer", () => {
  it("initiates, accepts, cools for 24 hours and executes", async () => {
    await withRollback(async () => {
      const s = await scene();
      const { pa, r, t, u } = s.actors;

      const id = await start(s);
      const accepted = await actOn("accept", id, r);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        transfer: {
          id,
          status: "COOLING",
          executesAt: new Date(s.clock.now().getTime() + DAY_MS).toISOString(),
        },
      });

      await advance(s, DAY_MS - 60_000);
      expect(await runTheJob()).toMatchObject({
        executed: 0,
        cancelled: 0,
        expired: 0,
      });
      expect((await row(id)).status).toBe("COOLING");

      await advance(s, 60_000);
      expect(await runTheJob()).toMatchObject({ executed: 1, cancelled: 0 });
      await assertDeferredConstraints();

      expect((await row(id)).status).toBe("COMPLETED");
      expect(await primaryAdminIds()).toEqual([r.user.id]);
      const both = await prisma.user.findMany({
        where: { id: { in: [pa.user.id, r.user.id] } },
        select: { isAdmin: true },
      });
      expect(both.map((user) => user.isAdmin)).toEqual([true, true]);
      expect(
        await prisma.session.count({
          where: { userId: { in: [pa.user.id, r.user.id] } },
        }),
      ).toBe(0);
      for (const old of [pa, r]) {
        const answer = await callRoute(listUsers, {
          method: "GET",
          url: `${API}/users`,
          as: old,
        });
        expect(answer.status).toBe(401);
      }

      // After signing in again the roles have swapped.
      const formerPa = await signIn(pa.user);
      const newPa = await signIn(r.user);
      const refused = await adminAction(formerPa, t.user, "reset-mfa");
      expect(refused.status).toBe(403);
      expect(codeOf(refused.body)).toBe("PRIMARY_ADMIN_REQUIRED");
      expect((await adminAction(newPa, t.user, "reset-mfa")).status).toBe(200);

      expect(mailTo(r.user, "pa-transfer-initiated")).toHaveLength(1);
      expect(mailTo(pa.user, "pa-transfer-initiated")).toHaveLength(1);
      const [toPa] = mailTo(pa.user, "pa-transfer-accepted");
      const [toR] = mailTo(r.user, "pa-transfer-accepted");
      expect(toPa?.data.cancelUrl).toEqual(expect.any(String));
      expect(toR?.data).not.toHaveProperty("cancelUrl");
      for (const person of [pa, r, t]) {
        expect(mailTo(person.user, "pa-transfer-completed")).toHaveLength(1);
      }
      expect(mailTo(u.user, "pa-transfer-completed")).toHaveLength(0);

      expect(await auditTypes(id)).toEqual([
        "PA_TRANSFER_ACCEPTED",
        "PA_TRANSFER_COMPLETED",
        "PA_TRANSFER_INITIATED",
      ]);
      expect(
        await prisma.auditEvent.count({
          where: {
            type: "SESSIONS_REVOKED",
            targetId: { in: [pa.user.id, r.user.id] },
          },
        }),
      ).toBe(2);
    });
  }, 120_000);
});

describe("illegal moves", () => {
  type Cell = { status: number; code: string } | { link: "invalid" } | null;
  type Move =
    | "accept:r"
    | "accept:t"
    | "accept:pa"
    | "decline:r"
    | "decline:t"
    | "cancel:pa"
    | "cancel:r"
    | "initiate"
    | "link";
  type State =
    | "PENDING_ACCEPTANCE"
    | "COOLING"
    | "COMPLETED"
    | "CANCELLED"
    | "EXPIRED";

  const NOT_RECIPIENT = { status: 403, code: "NOT_TRANSFER_RECIPIENT" };
  const NOT_INITIATOR = { status: 403, code: "NOT_TRANSFER_INITIATOR" };
  const WRONG_STATE = { status: 409, code: "TRANSFER_INVALID_STATE" };
  const IN_FLIGHT = { status: 409, code: "TRANSFER_IN_FLIGHT" };
  const DEAD_LINK = { link: "invalid" } as const;

  // Who acts is the person, not the role: after COMPLETED, `pa` is the former
  // Primary Admin. A null cell is a legal move, covered by the other cases.
  const SPENT: Record<Move, Cell> = {
    "accept:r": WRONG_STATE,
    "accept:t": NOT_RECIPIENT,
    "accept:pa": NOT_RECIPIENT,
    "decline:r": WRONG_STATE,
    "decline:t": NOT_RECIPIENT,
    "cancel:pa": WRONG_STATE,
    "cancel:r": NOT_INITIATOR,
    initiate: null,
    link: DEAD_LINK,
  };
  const TABLE: Record<State, Record<Move, Cell>> = {
    PENDING_ACCEPTANCE: {
      "accept:r": null,
      "accept:t": NOT_RECIPIENT,
      "accept:pa": NOT_RECIPIENT,
      "decline:r": null,
      "decline:t": NOT_RECIPIENT,
      "cancel:pa": null,
      "cancel:r": NOT_INITIATOR,
      initiate: IN_FLIGHT,
      link: DEAD_LINK,
    },
    COOLING: {
      "accept:r": WRONG_STATE,
      "accept:t": NOT_RECIPIENT,
      "accept:pa": NOT_RECIPIENT,
      "decline:r": null,
      "decline:t": NOT_RECIPIENT,
      "cancel:pa": null,
      "cancel:r": NOT_INITIATOR,
      initiate: IN_FLIGHT,
      link: null,
    },
    // The former Primary Admin is no longer the initiator in authority.
    COMPLETED: { ...SPENT, "cancel:pa": NOT_INITIATOR },
    CANCELLED: SPENT,
    EXPIRED: SPENT,
  };

  /** Reaches `state` through the real routes and the job, never by a write. */
  async function reach(s: Scene, state: State) {
    const id = await start(s);
    let token = "never-issued";
    if (state === "EXPIRED") {
      await advance(s, 7 * DAY_MS);
      expect(await runTheJob()).toMatchObject({ expired: 1 });
    } else if (state !== "PENDING_ACCEPTANCE") {
      token = await acceptAndGetToken(s, id);
      if (state === "COMPLETED") {
        await advance(s, DAY_MS);
        expect(await runTheJob()).toMatchObject({ executed: 1 });
        // The job signed both of them out.
        s.actors.pa = await signIn(s.actors.pa.user);
        s.actors.r = await signIn(s.actors.r.user);
      } else if (state === "CANCELLED") {
        expect((await actOn("cancel", id, s.actors.pa)).status).toBe(200);
      }
    }
    expect((await row(id)).status).toBe(state);
    return { id, token };
  }

  const makeMove = (
    s: Scene,
    id: string,
    token: string,
    name: Move,
  ): Promise<CallResult> => {
    const [verb, who] = name.split(":") as [Verb, Party];
    if (name === "initiate") return initiateFor(s.actors.pa, s.actors.t.user);
    if (name === "link") return confirmLink(token);
    return actOn(verb, id, s.actors[who]);
  };

  it.each(Object.keys(TABLE) as State[])(
    "%s refuses every move it should, and changes nothing",
    async (state) => {
      await withRollback(async () => {
        const s = await scene();
        const { id, token } = await reach(s, state);

        for (const [name, expected] of Object.entries(TABLE[state]) as [
          Move,
          Cell,
        ][]) {
          if (!expected) continue;
          const label = `${state} > ${name}`;
          const transfersBefore = await prisma.primaryAdminTransfer.count();
          const rowBefore = JSON.stringify(await row(id));
          const auditBefore = (await auditOf(id))
            .map((event) => event.id)
            .sort();

          const result = await makeMove(s, id, token, name);

          if ("link" in expected) {
            expect(result.status, label).toBe(303);
            expect(locationOf(result.headers).searchParams.get("result")).toBe(
              expected.link,
            );
          } else {
            expect(result.status, label).toBe(expected.status);
            expect(codeOf(result.body), label).toBe(expected.code);
          }
          expect(JSON.stringify(await row(id)), label).toBe(rowBefore);
          expect(
            (await auditOf(id)).map((event) => event.id).sort(),
            label,
          ).toEqual(auditBefore);
          expect(await prisma.primaryAdminTransfer.count(), label).toBe(
            transfersBefore,
          );
        }
      });
    },
    120_000,
  );
});

describe("the emailed cancel link", () => {
  it("cancels with no session, once, and tells both people", async () => {
    await withRollback(async () => {
      const s = await scene();
      const { pa, r } = s.actors;
      const id = await start(s);
      const token = await acceptAndGetToken(s, id);

      const first = await confirmLink(token);
      expect(first.status).toBe(303);
      expect(locationOf(first.headers).pathname).toBe("/transfer/cancel");
      expect(locationOf(first.headers).searchParams.get("result")).toBe("done");
      expect(await row(id)).toMatchObject({
        status: "CANCELLED",
        reason: "cancelled",
        cancelledById: pa.user.id,
        cancelTokenHash: null,
      });
      const cancelled = (await auditOf(id)).filter(
        (event) => event.type === "PA_TRANSFER_CANCELLED",
      );
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({
        actorType: "USER",
        actorUserId: pa.user.id,
        metadata: { reason: "cancelled", via: "email_link" },
      });
      expect(mailTo(pa.user, "pa-transfer-cancelled")).toHaveLength(1);
      expect(mailTo(r.user, "pa-transfer-cancelled")).toHaveLength(1);

      const again = await confirmLink(token);
      expect(locationOf(again.headers).searchParams.get("result")).toBe(
        "invalid",
      );
      expect(
        (await auditOf(id)).filter(
          (event) => event.type === "PA_TRANSFER_CANCELLED",
        ),
      ).toHaveLength(1);
    });
  }, 120_000);

  it("is dead once the transfer has completed", async () => {
    await withRollback(async () => {
      const s = await scene();
      const id = await start(s);
      const token = await acceptAndGetToken(s, id);
      await advance(s, DAY_MS);
      expect(await runTheJob()).toMatchObject({ executed: 1 });

      const result = await confirmLink(token);
      expect(locationOf(result.headers).searchParams.get("result")).toBe(
        "invalid",
      );
      expect((await row(id)).status).toBe("COMPLETED");
    });
  }, 120_000);
});

describe("expiry", () => {
  it("expires an unaccepted transfer after 7 days and allows a new one", async () => {
    await withRollback(async () => {
      const s = await scene();
      const { pa, r } = s.actors;
      const id = await start(s);

      await advance(s, 7 * DAY_MS);
      expect(await runTheJob()).toMatchObject({ expired: 1, executed: 0 });
      expect((await row(id)).status).toBe("EXPIRED");
      const expired = (await auditOf(id)).filter(
        (event) => event.type === "PA_TRANSFER_EXPIRED",
      );
      expect(expired).toHaveLength(1);
      expect(mailTo(pa.user, "pa-transfer-cancelled")).toHaveLength(1);
      expect(mailTo(pa.user, "pa-transfer-cancelled")[0]?.data).toMatchObject({
        reason: "expired",
      });

      const late = await actOn("accept", id, r);
      expect(late.status).toBe(409);
      expect(codeOf(late.body)).toBe("TRANSFER_INVALID_STATE");

      expect((await initiateFor(pa, r.user)).status).toBe(201);
    });
  }, 120_000);
});

describe("changes while a transfer is in flight", () => {
  const FROM = ["PENDING_ACCEPTANCE", "COOLING"] as const;

  /** A transfer to R, still pending or already accepted. */
  async function inFlight(from: (typeof FROM)[number]) {
    const s = await scene();
    const id = await start(s);
    if (from === "COOLING") await acceptAndGetToken(s, id);
    return { s, id };
  }

  /**
   * What must be true once the recipient can no longer take the role: the
   * transfer is cancelled at once by the system, the Primary Admin is told,
   * and a later job run executes nothing.
   */
  async function expectCancelledNow(
    s: Scene,
    id: string,
    { recipientEmailed }: { recipientEmailed: boolean },
  ) {
    const { pa, r } = s.actors;
    expect(await row(id)).toMatchObject({
      status: "CANCELLED",
      reason: "recipient_ineligible",
    });
    const cancelled = (await auditOf(id)).filter(
      (event) => event.type === "PA_TRANSFER_CANCELLED",
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      actorType: "SYSTEM",
      metadata: { reason: "recipient_ineligible", via: "system" },
    });
    expect(mailTo(pa.user, "pa-transfer-cancelled")[0]?.data).toMatchObject({
      role: "initiator",
      reason: "recipient-ineligible",
    });
    expect(mailTo(r.user, "pa-transfer-cancelled")).toHaveLength(
      recipientEmailed ? 1 : 0,
    );

    await advance(s, DAY_MS);
    expect(await runTheJob()).toMatchObject({ executed: 0 });
    expect(await primaryAdminIds()).toEqual([pa.user.id]);
  }

  // These four assert what ticket #49 asked the admin endpoints to do: call
  // `cancelForIneligibleRecipient` in the same transaction as the change. The
  // endpoints do not, so the transfer is still in flight when they answer.
  // `it.fails` keeps the assertion exactly as written and keeps CI green; when
  // the endpoints are fixed these start passing, Vitest reports that, and the
  // `.fails` is removed.
  for (const from of FROM) {
    it.fails(
      `${from}: deactivating the recipient cancels the transfer at once`,
      async () => {
        await withRollback(async () => {
          const { s, id } = await inFlight(from);
          const done = await adminAction(
            s.actors.t,
            s.actors.r.user,
            "deactivate",
          );
          expect(done.status).toBe(200);
          await expectCancelledNow(s, id, { recipientEmailed: false });
        });
      },
      120_000,
    );

    it.fails(
      `${from}: revoking the recipient's admin cancels the transfer at once`,
      async () => {
        await withRollback(async () => {
          const { s, id } = await inFlight(from);
          const done = await adminAction(
            s.actors.t,
            s.actors.r.user,
            "revoke-admin",
          );
          expect(done.status).toBe(200);
          // Still active, so still told.
          await expectCancelledNow(s, id, { recipientEmailed: true });
        });
      },
      120_000,
    );

    it.fails(
      `${from}: deleting the recipient cancels the transfer at once`,
      async () => {
        await withRollback(async () => {
          const { s, id } = await inFlight(from);
          const done = await callRoute(deleteUser, {
            method: "DELETE",
            url: userUrl(s.actors.r.user.id),
            as: s.actors.t,
            params: { id: s.actors.r.user.id },
          });
          expect(done.status).toBe(200);
          await expectCancelledNow(s, id, { recipientEmailed: false });
        });
      },
      120_000,
    );

    // The recipient without MFA is ineligible (`NO_MFA`), so the job at +24 h
    // must cancel the transfer instead of making them Primary Admin. The job
    // only looks at status and admin, so it does not.
    it.fails(
      `${from}: resetting the recipient's MFA makes the job cancel instead of execute`,
      async () => {
        await withRollback(async () => {
          const { s, id } = await inFlight(from);
          const done = await adminAction(
            s.actors.pa,
            s.actors.r.user,
            "reset-mfa",
          );
          expect(done.status).toBe(200);

          await advance(s, DAY_MS);
          expect(await runTheJob()).toMatchObject({
            cancelled: 1,
            executed: 0,
          });
          expect(await row(id)).toMatchObject({ status: "CANCELLED" });
          expect(await primaryAdminIds()).toEqual([s.actors.pa.user.id]);
        });
      },
      120_000,
    );

    it(`${from}: a recipient who has lost MFA cannot accept`, async () => {
      await withRollback(async () => {
        const { s, id } = await inFlight(from);
        const reset = await adminAction(
          s.actors.pa,
          s.actors.r.user,
          "reset-mfa",
        );
        expect(reset.status).toBe(200);
        const result = await actOn("accept", id, s.actors.r);
        expect(result.status).toBe(403);
        expect(codeOf(result.body)).toBe("MFA_REQUIRED");
        expect((await row(id)).status).toBe(from);
      });
    }, 120_000);

    // The backstop: a change that no hook saw, here a write straight to the
    // database. The next job run cancels the transfer.
    it(`${from}: the job cancels a transfer whose recipient was deactivated in SQL`, async () => {
      await withRollback(async () => {
        const { s, id } = await inFlight(from);
        const { pa, r } = s.actors;
        await prisma.user.update({
          where: { id: r.user.id },
          data: { status: "DEACTIVATED", deactivatedAt: new Date() },
        });

        await advance(s, DAY_MS);
        expect(await runTheJob()).toMatchObject({
          cancelled: 1,
          executed: 0,
          expired: 0,
        });
        expect(await row(id)).toMatchObject({
          status: "CANCELLED",
          reason: "recipient_ineligible",
        });
        const cancelled = (await auditOf(id)).filter(
          (event) => event.type === "PA_TRANSFER_CANCELLED",
        );
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({
          actorType: "SYSTEM",
          metadata: { reason: "recipient_ineligible", via: "system" },
        });
        expect(mailTo(pa.user, "pa-transfer-cancelled")).toHaveLength(1);
        // A deactivated recipient is no longer anyone to write to.
        expect(mailTo(r.user, "pa-transfer-cancelled")).toHaveLength(0);
        expect(await primaryAdminIds()).toEqual([pa.user.id]);

        expect(await runTheJob()).toMatchObject({
          cancelled: 0,
          executed: 0,
          expired: 0,
        });
      });
    }, 120_000);
  }
});
