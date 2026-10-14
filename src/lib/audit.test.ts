import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { parseAuditEvent, writeAuditEvent } from "@/lib/audit";

function fakeDb() {
  const create = vi.fn();
  const db = { auditEvent: { create } } as unknown as Pick<
    Prisma.TransactionClient,
    "auditEvent"
  >;
  return { db, create };
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
      }),
    ).not.toThrow();
    expect(() =>
      parseAuditEvent({ type: "JWKS_ROTATED", actorType: "SYSTEM" }),
    ).not.toThrow();
    expect(() =>
      parseAuditEvent({
        type: "BREAK_GLASS_PA_RECOVERY",
        actorType: "BREAK_GLASS",
      }),
    ).not.toThrow();
  });

  it("rejects a USER actor without an id and a SYSTEM actor with one", () => {
    expect(() =>
      parseAuditEvent({ type: "LOGIN_SUCCESS", actorType: "USER" }),
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
    const base = { type: "USER_CREATED", actorType: "SYSTEM" };
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
      ip: "203.0.113.7",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: "u1",
        ip: "203.0.113.7",
        metadata: {},
      }),
    });
  });
});
