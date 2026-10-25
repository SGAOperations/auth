import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  audit,
  auditRequestInfo,
  parseAuditEvent,
  withAuditContext,
  withAuditTransaction,
  writeAuditEvent,
} from "@/lib/audit";

const requestHeaders = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ headers: requestHeaders }));

afterEach(() => {
  requestHeaders.mockReset();
});

const transferMetadata = {
  mode: "transfer",
  operator: "Ada Lovelace",
  reason: "Primary Admin unreachable",
  previousPrimaryAdminId: "u-old",
  previousAdminRevoked: false,
  sessionsRevoked: 2,
};

const breakGlassEvent = {
  type: "BREAK_GLASS_PA_RECOVERY",
  actorType: "BREAK_GLASS",
  targetType: "USER",
  targetId: "u-new",
  metadata: transferMetadata,
};

function fakeDb() {
  const create = vi.fn();
  const db = { auditEvent: { create } } as unknown as Pick<
    Prisma.TransactionClient,
    "auditEvent"
  >;
  return { db, create };
}

function lastData(create: ReturnType<typeof vi.fn>) {
  return create.mock.calls.at(-1)?.[0].data;
}

describe("parseAuditEvent", () => {
  it("rejects a type that is not in the catalog", () => {
    let error: unknown;
    try {
      parseAuditEvent({ type: "NOT_A_REAL_EVENT", actorType: "SYSTEM" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]?.path).toEqual(["type"]);
  });

  it("accepts each valid actorType and actorUserId pair", () => {
    expect(() =>
      parseAuditEvent({
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: "u1",
        metadata: { method: "password" },
      }),
    ).not.toThrow();
    expect(() =>
      parseAuditEvent({ type: "JWKS_ROTATED", actorType: "SYSTEM" }),
    ).not.toThrow();
    expect(() =>
      parseAuditEvent({
        ...breakGlassEvent,
      }),
    ).not.toThrow();
  });

  it("accepts the second-factor login methods, failure reason and event", () => {
    const user = {
      actorType: "USER",
      actorUserId: "u1",
      targetType: "USER",
      targetId: "u1",
    };
    for (const method of ["totp", "backup_code"]) {
      expect(() =>
        parseAuditEvent({
          type: "LOGIN_SUCCESS",
          ...user,
          metadata: { method },
        }),
      ).not.toThrow();
    }
    expect(() =>
      parseAuditEvent({
        type: "LOGIN_FAILED",
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: "u1",
        metadata: { reason: "INVALID_TWO_FACTOR_CODE" },
      }),
    ).not.toThrow();
    expect(() =>
      parseAuditEvent({ type: "MFA_BACKUP_CODES_REGENERATED", ...user }),
    ).not.toThrow();
  });

  describe("lockout events", () => {
    const target = { targetType: "USER", targetId: "u1" };

    it("accepts ACCOUNT_LOCKED with a level and a duration", () => {
      expect(() =>
        parseAuditEvent({
          type: "ACCOUNT_LOCKED",
          actorType: "SYSTEM",
          ...target,
          metadata: { lockLevel: 1, durationMinutes: 15 },
        }),
      ).not.toThrow();
    });

    it.each([
      {},
      { lockLevel: 1 },
      { lockLevel: 0, durationMinutes: 15 },
      { lockLevel: 1, durationMinutes: 0 },
      { lockLevel: 1, durationMinutes: 15, email: "x@northeastern.edu" },
    ])("rejects ACCOUNT_LOCKED metadata %j", (metadata) => {
      expect(() =>
        parseAuditEvent({
          type: "ACCOUNT_LOCKED",
          actorType: "SYSTEM",
          ...target,
          metadata,
        }),
      ).toThrow(ZodError);
    });

    it.each(["email_link", "password_reset", "admin"])(
      "accepts ACCOUNT_UNLOCKED by %s",
      (method) => {
        expect(() =>
          parseAuditEvent({
            type: "ACCOUNT_UNLOCKED",
            actorType: "USER",
            actorUserId: "u1",
            ...target,
            metadata: { method },
          }),
        ).not.toThrow();
      },
    );

    it("rejects ACCOUNT_UNLOCKED without a known method", () => {
      const base = {
        type: "ACCOUNT_UNLOCKED",
        actorType: "USER",
        actorUserId: "u1",
        ...target,
      };
      expect(() => parseAuditEvent(base)).toThrow(ZodError);
      expect(() =>
        parseAuditEvent({ ...base, metadata: { method: "magic" } }),
      ).toThrow(ZodError);
    });

    it("accepts LOGIN_FAILED for a locked account", () => {
      expect(() =>
        parseAuditEvent({
          type: "LOGIN_FAILED",
          actorType: "SYSTEM",
          ...target,
          metadata: { reason: "ACCOUNT_LOCKED" },
        }),
      ).not.toThrow();
    });
  });

  it("rejects a USER actor without an id and a SYSTEM actor with one", () => {
    expect(() =>
      parseAuditEvent({
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        metadata: { method: "password" },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseAuditEvent({
        type: "JWKS_ROTATED",
        actorType: "SYSTEM",
        actorUserId: "u1",
      }),
    ).toThrow(ZodError);
  });

  it("requires targetType and targetId together", () => {
    const base = {
      type: "USER_CREATED",
      actorType: "SYSTEM",
      metadata: { source: "system" },
    };
    expect(() => parseAuditEvent({ ...base, targetType: "USER" })).toThrow(
      ZodError,
    );
    expect(() => parseAuditEvent({ ...base, targetId: "u1" })).toThrow(
      ZodError,
    );
    expect(() => parseAuditEvent(base)).not.toThrow();
    expect(() =>
      parseAuditEvent({ ...base, targetType: "USER", targetId: "u1" }),
    ).not.toThrow();
  });

  it("defaults metadata to an empty object and rejects a non-object", () => {
    const base = { type: "JWKS_ROTATED", actorType: "SYSTEM" };
    expect(parseAuditEvent(base).metadata).toEqual({});
    expect(() => parseAuditEvent({ ...base, metadata: "x" })).toThrow(ZodError);
  });

  it("truncates a long userAgent to 512 characters instead of rejecting", () => {
    const parsed = parseAuditEvent({
      type: "JWKS_ROTATED",
      actorType: "SYSTEM",
      userAgent: "a".repeat(600),
    });
    expect(parsed.userAgent).toHaveLength(512);
  });

  it("rejects a malformed ip", () => {
    expect(() =>
      parseAuditEvent({
        type: "JWKS_ROTATED",
        actorType: "SYSTEM",
        ip: "not-an-ip",
      }),
    ).toThrow(ZodError);
  });

  it("rejects a metadata key the catalog does not define", () => {
    let error: unknown;
    try {
      parseAuditEvent({
        type: "JWKS_ROTATED",
        actorType: "SYSTEM",
        metadata: { email: "x@northeastern.edu" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]?.path[0]).toBe("metadata");
  });

  it("requires the metadata a type defines and checks its values", () => {
    const base = { type: "LOGIN_SUCCESS", actorType: "SYSTEM" };
    expect(() => parseAuditEvent(base)).toThrow(ZodError);
    expect(() =>
      parseAuditEvent({ ...base, metadata: { method: "carrier_pigeon" } }),
    ).toThrow(ZodError);
  });

  it("rejects a targetType other than the one the type targets", () => {
    const base = { type: "LOGOUT", actorType: "SYSTEM", targetId: "s1" };
    let error: unknown;
    try {
      parseAuditEvent({ ...base, targetType: "USER" });
    } catch (caught) {
      error = caught;
    }
    expect((error as ZodError).issues[0]?.path).toEqual(["targetType"]);
    expect(() =>
      parseAuditEvent({ ...base, targetType: "SESSION" }),
    ).not.toThrow();
  });

  it("allows the BREAK_GLASS actor only on BREAK_GLASS_PA_RECOVERY", () => {
    expect(() =>
      parseAuditEvent({
        type: "LOGIN_SUCCESS",
        actorType: "BREAK_GLASS",
        metadata: { method: "password" },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseAuditEvent({ ...breakGlassEvent, actorType: "SYSTEM" }),
    ).toThrow(ZodError);
  });

  describe("BREAK_GLASS_PA_RECOVERY metadata", () => {
    const withMetadata = (metadata: unknown) => ({
      ...breakGlassEvent,
      metadata,
    });

    it("accepts a reset_mfa event and measures length after trimming", () => {
      expect(() =>
        parseAuditEvent(
          withMetadata({
            mode: "reset_mfa",
            operator: "Ada",
            reason: "lost phone and codes",
            sessionsRevoked: 0,
          }),
        ),
      ).not.toThrow();
      expect(() =>
        parseAuditEvent(
          withMetadata({
            mode: "reset_mfa",
            operator: "Ada",
            reason: "   short   ",
            sessionsRevoked: 0,
          }),
        ),
      ).toThrow(ZodError);
    });

    it("accepts a transfer with no previous Primary Admin", () => {
      expect(() =>
        parseAuditEvent(
          withMetadata({
            ...transferMetadata,
            previousPrimaryAdminId: null,
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a missing mode", () => {
      const rest: Record<string, unknown> = { ...transferMetadata };
      delete rest.mode;
      expect(() => parseAuditEvent(withMetadata(rest))).toThrow(ZodError);
    });

    it("rejects an unknown key", () => {
      expect(() =>
        parseAuditEvent(
          withMetadata({ ...transferMetadata, email: "pa@northeastern.edu" }),
        ),
      ).toThrow(ZodError);
    });

    it("rejects a key from the other mode", () => {
      expect(() =>
        parseAuditEvent(
          withMetadata({
            mode: "reset_mfa",
            operator: "Ada",
            reason: "lost phone and codes",
            sessionsRevoked: 0,
            previousAdminRevoked: false,
          }),
        ),
      ).toThrow(ZodError);
    });

    it("rejects a reason shorter than 10 characters", () => {
      expect(() =>
        parseAuditEvent(withMetadata({ ...transferMetadata, reason: "short" })),
      ).toThrow(ZodError);
    });

    it("rejects an empty operator and a negative session count", () => {
      expect(() =>
        parseAuditEvent(withMetadata({ ...transferMetadata, operator: " " })),
      ).toThrow(ZodError);
      expect(() =>
        parseAuditEvent(
          withMetadata({ ...transferMetadata, sessionsRevoked: -1 }),
        ),
      ).toThrow(ZodError);
    });
  });
});

describe("writeAuditEvent", () => {
  it("does not touch the database for an unknown type", async () => {
    const { db, create } = fakeDb();
    await expect(
      writeAuditEvent(db, { type: "NOT_A_REAL_EVENT", actorType: "SYSTEM" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a valid event once with the parsed data", async () => {
    const { db, create } = fakeDb();
    await writeAuditEvent(db, {
      type: "LOGIN_SUCCESS",
      actorType: "USER",
      actorUserId: "u1",
      metadata: { method: "password" },
      ip: "203.0.113.7",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: "u1",
        ip: "203.0.113.7",
        metadata: { method: "password" },
      }),
    });
  });
});

describe("auditRequestInfo", () => {
  const info = (init: Record<string, string>) =>
    auditRequestInfo(new Headers(init));

  it("prefers x-real-ip over the first x-forwarded-for hop", () => {
    expect(
      info({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "203.0.113.2" }).ip,
    ).toBe("203.0.113.1");
    expect(info({ "x-forwarded-for": " 203.0.113.2 , 10.0.0.1" }).ip).toBe(
      "203.0.113.2",
    );
  });

  it("returns null, never a placeholder, for a missing or malformed ip", () => {
    expect(info({}).ip).toBeNull();
    expect(info({ "x-forwarded-for": "unknown, 1.2.3.4" }).ip).toBeNull();
    expect(info({ "x-real-ip": "not-an-ip" }).ip).toBeNull();
  });

  it("reads the user agent", () => {
    expect(info({ "user-agent": "vitest" }).userAgent).toBe("vitest");
    expect(info({}).userAgent).toBeNull();
  });
});

describe("audit", () => {
  const system = { actorType: "SYSTEM" } as const;

  it("writes through options.db over the context's db", async () => {
    const option = fakeDb();
    const ambient = fakeDb();
    await withAuditContext({ db: ambient.db }, () =>
      audit({ type: "JWKS_ROTATED", ...system }, { db: option.db }),
    );
    expect(option.create).toHaveBeenCalledTimes(1);
    expect(ambient.create).not.toHaveBeenCalled();
  });

  it("writes through the transaction inside withAuditTransaction", async () => {
    const tx = fakeDb();
    const client = {
      $transaction: (fn: (tx: unknown) => unknown) => fn(tx.db),
    } as unknown as PrismaClient;

    await withAuditTransaction(client, async () => {
      await audit({ type: "JWKS_ROTATED", ...system });
    });
    expect(tx.create).toHaveBeenCalledTimes(1);
  });

  it("throws without an actor and writes nothing", async () => {
    const { db, create } = fakeDb();
    await expect(audit({ type: "JWKS_ROTATED" }, { db })).rejects.toThrow(
      "no actor for JWKS_ROTATED",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to the context actor, and the event's own actor wins", async () => {
    const { db, create } = fakeDb();
    await withAuditContext(
      { actor: { actorType: "USER", actorUserId: "ctx-user" } },
      async () => {
        await audit({ type: "PASSWORD_REHASHED" }, { db });
        expect(lastData(create)).toMatchObject({
          actorType: "USER",
          actorUserId: "ctx-user",
        });
        await audit({ type: "PASSWORD_REHASHED", ...system }, { db });
        expect(lastData(create)).toMatchObject({ actorType: "SYSTEM" });
        expect(lastData(create).actorUserId).toBeUndefined();
      },
    );
  });

  it("takes ip and user agent from options.headers, truncating the agent", async () => {
    const { db, create } = fakeDb();
    await audit(
      { type: "JWKS_ROTATED", ...system },
      {
        db,
        headers: new Headers({
          "x-real-ip": "203.0.113.1",
          "x-forwarded-for": "203.0.113.2",
          "user-agent": "a".repeat(600),
        }),
      },
    );
    const data = lastData(create);
    expect(data.ip).toBe("203.0.113.1");
    expect(data.userAgent).toHaveLength(512);
  });

  it("records a null ip for an unusable forwarded header", async () => {
    const { db, create } = fakeDb();
    await audit(
      { type: "JWKS_ROTATED", ...system },
      {
        db,
        headers: new Headers({ "x-forwarded-for": "unknown, 1.2.3.4" }),
      },
    );
    expect(lastData(create).ip).toBeNull();
  });

  it("uses next/headers as the last fallback", async () => {
    const { db, create } = fakeDb();
    requestHeaders.mockResolvedValue(
      new Headers({ "x-real-ip": "198.51.100.4", "user-agent": "next-ua" }),
    );
    await audit({ type: "JWKS_ROTATED", ...system }, { db });
    expect(lastData(create)).toMatchObject({
      ip: "198.51.100.4",
      userAgent: "next-ua",
    });
  });

  it("records nulls when there is no request scope", async () => {
    const { db, create } = fakeDb();
    requestHeaders.mockRejectedValue(new Error("outside a request scope"));
    await audit({ type: "JWKS_ROTATED", ...system }, { db });
    const data = lastData(create);
    expect(data.ip).toBeNull();
    expect(data.userAgent).toBeUndefined();
  });

  it("rejects wrong metadata before touching the database", async () => {
    const { db, create } = fakeDb();
    await expect(
      audit(
        {
          type: "LOGIN_SUCCESS",
          ...system,
          // @ts-expect-error -- method must be one of the catalog's values
          metadata: { method: "carrier_pigeon" },
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(create).not.toHaveBeenCalled();
  });
});
