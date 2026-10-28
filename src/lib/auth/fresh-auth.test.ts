import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  createFreshAuthGuard,
  hasFreshAuth,
  reauthRequiredResponse,
} from "@/lib/auth/fresh-auth";

const NOW = new Date("2026-01-01T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

type Row = { lastReauthAt: Date | null } | null;

// A stub of the one delegate method the guard reads.
function stubDb(row: Row) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const db = { session: { findUnique } } as unknown as Pick<
    PrismaClient,
    "session"
  >;
  return { db, findUnique };
}

const session = { session: { id: "s1" }, user: { id: "u1" } };

describe("hasFreshAuth", () => {
  it("reads the stamp of the named session", async () => {
    const { db, findUnique } = stubDb({ lastReauthAt: minutesAgo(5) });
    expect(await hasFreshAuth(db, "s1", NOW)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "s1" },
      select: { lastReauthAt: true },
    });
  });

  it.each<[string, Row]>([
    ["no row", null],
    ["no stamp", { lastReauthAt: null }],
    ["an 11 minute old stamp", { lastReauthAt: minutesAgo(11) }],
  ])("is false for %s", async (_label, row) => {
    const { db } = stubDb(row);
    expect(await hasFreshAuth(db, "s1", NOW)).toBe(false);
  });
});

describe("requireFreshAuth", () => {
  function guard(row: Row, found = true) {
    return createFreshAuthGuard({
      getSession: async () => (found ? session : null),
      prisma: stubDb(row).db,
    });
  }

  it("answers 401 with no session", async () => {
    const result = await guard(null, false)(new Headers());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  });

  it.each<[string, Date | null]>([
    ["no stamp", null],
    ["an 11 minute old stamp", new Date(Date.now() - 11 * 60_000)],
  ])("answers 403 REAUTH_REQUIRED for %s", async (_label, lastReauthAt) => {
    const result = await guard({ lastReauthAt })(new Headers());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.response.json()).toMatchObject({
      code: "REAUTH_REQUIRED",
    });
  });

  it("passes a session re-authenticated 5 minutes ago, carrying it", async () => {
    const result = await guard({
      lastReauthAt: new Date(Date.now() - 5 * 60_000),
    })(new Headers());
    expect(result).toEqual({ ok: true, session });
  });
});

describe("reauthRequiredResponse", () => {
  it("is a no-store 403 carrying the code", async () => {
    const response = reauthRequiredResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
  });
});
