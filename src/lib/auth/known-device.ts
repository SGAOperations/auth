import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { DEVICE_COOKIE_MAX_AGE_SECONDS } from "@/lib/auth/cookies";

// The known-device cookie and its KnownDevice rows (docs/LOCKOUT.md,
// docs/SESSION-COOKIE.md). A browser earns one only by completing a login, so
// an attacker who merely knows an address cannot get one.

type DeviceDb = Pick<PrismaClient, "knownDevice">;

export interface DeviceCookie {
  name: string;
  secure: boolean;
}

/** A device idle this long is forgotten. */
export const DEVICE_IDLE_MAX_MS = DEVICE_COOKIE_MAX_AGE_SECONDS * 1000;
/** Per user, newest kept. A shared lab machine cannot grow the table. */
export const MAX_DEVICES_PER_USER = 20;

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Lower-case hex SHA-256, the same form as `hashUnlockToken`. */
export function hashDeviceToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Looks up by hash only, never by email, so the query is the same whichever
 * account the sign-in names.
 */
export async function findDevice(db: DeviceDb, raw: string) {
  return db.knownDevice.findUnique({
    where: { tokenHash: hashDeviceToken(raw) },
    select: {
      id: true,
      userId: true,
      failedCount: true,
      windowStartedAt: true,
      lockedUntil: true,
    },
  });
}

/**
 * Records a completed login on this browser and returns the raw token for its
 * cookie. A token this user already holds is touched and kept; anything else
 * (no cookie, another user's, an unknown one) gets a fresh token.
 */
export async function rememberDevice(
  db: DeviceDb,
  {
    userId,
    raw,
    userAgent,
    now,
  }: {
    userId: string;
    raw: string | null;
    userAgent: string | null;
    now: Date;
  },
): Promise<string> {
  if (raw) {
    const { count } = await db.knownDevice.updateMany({
      where: { tokenHash: hashDeviceToken(raw), userId },
      data: { lastSeenAt: now },
    });
    if (count === 1) return raw;
  }

  const fresh = newDeviceToken();
  await db.knownDevice.create({
    data: {
      userId,
      tokenHash: hashDeviceToken(fresh),
      userAgent,
      createdAt: now,
      lastSeenAt: now,
    },
  });
  await pruneDevices(db, userId, now);
  return fresh;
}

async function pruneDevices(db: DeviceDb, userId: string, now: Date) {
  await db.knownDevice.deleteMany({
    where: {
      userId,
      lastSeenAt: { lt: new Date(now.getTime() - DEVICE_IDLE_MAX_MS) },
    },
  });
  const surplus = await db.knownDevice.findMany({
    where: { userId },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    skip: MAX_DEVICES_PER_USER,
    select: { id: true },
  });
  if (surplus.length === 0) return;
  await db.knownDevice.deleteMany({
    where: { id: { in: surplus.map((device) => device.id) } },
  });
}

// The part of Better Auth's endpoint context the cookie I/O needs. The cookie
// is HMAC-signed with the auth secret, so a forged value is rejected before
// any database read.
interface SignedCookieReader {
  context: { secret: string };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}

interface SignedCookieWriter {
  context: { secret: string };
  setSignedCookie(
    name: string,
    value: string,
    secret: string,
    attributes: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      path: string;
      maxAge: number;
    },
  ): Promise<unknown>;
}

/** The raw token, or `null` when the cookie is absent, unsigned or forged. */
export async function readDeviceCookie(
  ctx: SignedCookieReader,
  cookie: DeviceCookie,
): Promise<string | null> {
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  return value || null;
}

/** Host-only on purpose: no `domain`. */
export async function writeDeviceCookie(
  ctx: SignedCookieWriter,
  cookie: DeviceCookie,
  raw: string,
): Promise<void> {
  await ctx.setSignedCookie(cookie.name, raw, ctx.context.secret, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
}
