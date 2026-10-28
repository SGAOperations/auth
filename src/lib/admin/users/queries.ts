import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ListQuery } from "@/lib/admin/users/schemas";

// Never selects Account.password, Session.token, TwoFactor.* or Verification.*:
// the DTO is the whole of what an admin response can carry.
export const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  preferredName: true,
  status: true,
  isAdmin: true,
  isPrimaryAdmin: true,
  emailVerified: true,
  twoFactorEnabled: true,
  legacyEmail: true,
  lastLoginAt: true,
  createdAt: true,
  deactivatedAt: true,
  deletedAt: true,
  accounts: {
    where: { providerId: "credential", password: { not: null } },
    select: { id: true },
    take: 1,
  },
  positions: {
    where: { position: { deletedAt: null } },
    select: { position: { select: { key: true, name: true } } },
  },
} as const satisfies Prisma.UserSelect;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  preferredName: string | null;
  status: AdminUserRow["status"];
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  legacyEmail: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  deactivatedAt: string | null;
  deletedAt: string | null;
  positions: { key: string; name: string }[];
}

export interface AdminUserDetail extends AdminUser {
  activeSessions: number;
  lockedUntil: string | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

// Plain code-unit order, the same as the session endpoint's position list.
const byKey = (a: { key: string }, b: { key: string }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

export function toAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    preferredName: row.preferredName,
    status: row.status,
    isAdmin: row.isAdmin,
    isPrimaryAdmin: row.isPrimaryAdmin,
    emailVerified: row.emailVerified,
    twoFactorEnabled: row.twoFactorEnabled,
    hasPassword: row.accounts.length > 0,
    legacyEmail: row.legacyEmail,
    lastLoginAt: iso(row.lastLoginAt),
    createdAt: row.createdAt.toISOString(),
    deactivatedAt: iso(row.deactivatedAt),
    deletedAt: iso(row.deletedAt),
    positions: row.positions
      .map(({ position }) => ({ key: position.key, name: position.name }))
      .sort(byKey),
  };
}

export async function listUsers(
  db: PrismaClient,
  { q, position, status, isAdmin, page, pageSize }: ListQuery,
): Promise<{
  users: AdminUser[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const where: Prisma.UserWhereInput = {
    status: status ?? { not: "DELETED" },
    ...(isAdmin === undefined ? {} : { isAdmin }),
    ...(q === undefined
      ? {}
      : {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { preferredName: { contains: q, mode: "insensitive" } },
          ],
        }),
    ...(position === undefined
      ? {}
      : {
          positions: {
            some: { position: { key: position, deletedAt: null } },
          },
        }),
  };

  const [rows, total] = await db.$transaction([
    db.user.findMany({
      where,
      select: ADMIN_USER_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
  ]);
  return { users: rows.map(toAdminUser), page, pageSize, total };
}

export async function getUser(
  db: Prisma.TransactionClient,
  id: string,
): Promise<AdminUser | null> {
  const row = await db.user.findUnique({
    where: { id },
    select: ADMIN_USER_SELECT,
  });
  return row ? toAdminUser(row) : null;
}

export async function getUserDetail(
  db: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<AdminUserDetail | null> {
  const user = await getUser(db, id);
  if (!user) return null;
  const [activeSessions, lock] = await Promise.all([
    db.session.count({
      where: {
        userId: id,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    }),
    db.accountLock.findUnique({
      where: { userId: id },
      select: { lockedUntil: true },
    }),
  ]);
  const lockedUntil =
    lock?.lockedUntil && lock.lockedUntil > now ? lock.lockedUntil : null;
  return { ...user, activeSessions, lockedUntil: iso(lockedUntil) };
}

/** What the per-target `can()` and the action preconditions read. */
export interface UserTarget {
  id: string;
  email: string;
  name: string;
  preferredName: string | null;
  status: AdminUserRow["status"];
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
}

export async function loadTarget(
  db: Prisma.TransactionClient,
  id: string,
): Promise<UserTarget | null> {
  const row = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      preferredName: true,
      status: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      twoFactorEnabled: true,
      accounts: ADMIN_USER_SELECT.accounts,
    },
  });
  if (!row) return null;
  const { accounts, ...rest } = row;
  return { ...rest, hasPassword: accounts.length > 0 };
}
