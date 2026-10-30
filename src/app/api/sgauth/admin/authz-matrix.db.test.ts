import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { can, USER_ACTIONS, type UserAction } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  API,
  auditTracker,
  buildWorld,
  callRoute,
  captured,
  codeOf,
  expectNoSecrets,
  snapshotUser,
  TARGET_KEYS,
  type Actor,
  type CallResult,
  type TargetKey,
  type World,
} from "@/test/admin-http";
import { createPosition } from "@/test/factories";
import { withRollback } from "@/test/rollback-prisma";
import { POST as initiateTransfer } from "./transfer/route";
import { PATCH as assignPositions } from "./users/[id]/positions/route";
import { POST as userAction } from "./users/[id]/[action]/route";
import { DELETE as deleteUser, PATCH as patchUser } from "./users/[id]/route";

// The actor x target x action matrix, driven through the live route modules:
// the real guard, `can()`, handlers, audit writer and transfer service. Only
// the session source, the mailer, the rate limiter and `next/headers` are
// replaced (src/test/admin-http.ts). Each case runs in one transaction that
// rolls back, because the matrix needs a Primary Admin.
//
// The expected values below are written out by hand. They are checked against
// the HTTP answer and, for the authorization reasons, against `can()` itself,
// so the table here and src/lib/authz.test.ts cannot drift apart silently.

type Expected = { status: number; code?: string };
const OK: Expected = { status: 200 };
const CREATED: Expected = { status: 201 };
const deny = (code: string): Expected => ({ status: 403, code });
const conflict = (code: string): Expected => ({ status: 409, code });

/** Columns in the order of TARGET_KEYS: self, other user, other admin, Primary Admin. */
type Row = readonly [Expected, Expected, Expected, Expected];

interface ActionDef {
  name: string;
  /** The `can()` action the route gates on. */
  authz: UserAction;
  /** The audit event type a success writes. */
  audit: string;
  /** A repeat on the same user is a no-op: no write and no audit row. */
  idempotent?: true;
  call(
    as: Actor | null,
    target: User,
    extra: { positionId: string },
  ): Promise<CallResult>;
}

const userUrl = (id: string, tail = "") => `${API}/users/${id}${tail}`;

const post = (
  name: string,
  authz: UserAction,
  audit: string,
  action: string,
): ActionDef => ({
  name,
  authz,
  audit,
  call: (as, target) =>
    callRoute(userAction, {
      method: "POST",
      url: userUrl(target.id, `/${action}`),
      as,
      params: { id: target.id, action },
    }),
});

const ACTIONS: ActionDef[] = [
  post("grant-admin", "grantAdmin", "ADMIN_GRANTED", "grant-admin"),
  post("revoke-admin", "revokeAdmin", "ADMIN_REVOKED", "revoke-admin"),
  post("deactivate", "deactivate", "USER_DEACTIVATED", "deactivate"),
  {
    name: "delete",
    authz: "delete",
    audit: "USER_DELETED",
    call: (as, target) =>
      callRoute(deleteUser, {
        method: "DELETE",
        url: userUrl(target.id),
        as,
        params: { id: target.id },
      }),
  },
  post("reset-mfa", "resetMfa", "MFA_RESET", "reset-mfa"),
  {
    name: "update-profile",
    authz: "updateProfile",
    audit: "USER_UPDATED",
    idempotent: true,
    call: (as, target) =>
      callRoute(patchUser, {
        method: "PATCH",
        url: userUrl(target.id),
        as,
        body: { name: "Renamed" },
        params: { id: target.id },
      }),
  },
  {
    name: "assign-position",
    authz: "assignPosition",
    audit: "POSITION_ASSIGNED",
    idempotent: true,
    call: (as, target, { positionId }) =>
      callRoute(assignPositions, {
        method: "PATCH",
        url: userUrl(target.id, "/positions"),
        as,
        body: { assign: [positionId] },
        params: { id: target.id },
      }),
  },
  {
    name: "initiate-transfer",
    authz: "initiateTransfer",
    audit: "PA_TRANSFER_INITIATED",
    call: (as, target) =>
      callRoute(initiateTransfer, {
        method: "POST",
        url: `${API}/transfer`,
        as,
        body: { recipientUserId: target.id, confirmEmail: target.email },
      }),
  },
];

// A missing or extra row fails the first test below, not the compiler.
const ADMIN: Record<string, Row> = {
  "grant-admin": [
    deny("SELF_MODIFICATION"),
    OK,
    conflict("ALREADY_ADMIN"),
    deny("PRIMARY_ADMIN_PROTECTED"),
  ],
  "revoke-admin": [
    deny("SELF_MODIFICATION"),
    conflict("NOT_AN_ADMIN"),
    OK,
    deny("PRIMARY_ADMIN_PROTECTED"),
  ],
  deactivate: [
    deny("SELF_MODIFICATION"),
    OK,
    OK,
    deny("PRIMARY_ADMIN_PROTECTED"),
  ],
  delete: [deny("SELF_MODIFICATION"), OK, OK, deny("PRIMARY_ADMIN_PROTECTED")],
  "reset-mfa": [
    deny("PRIMARY_ADMIN_REQUIRED"),
    OK,
    deny("PRIMARY_ADMIN_REQUIRED"),
    deny("PRIMARY_ADMIN_PROTECTED"),
  ],
  "update-profile": [OK, OK, OK, OK],
  "assign-position": [OK, OK, OK, OK],
  "initiate-transfer": [
    deny("SELF_MODIFICATION"),
    deny("PRIMARY_ADMIN_REQUIRED"),
    deny("PRIMARY_ADMIN_REQUIRED"),
    deny("PRIMARY_ADMIN_REQUIRED"),
  ],
};

// For the Primary Admin actor `self` and the Primary Admin column are the same
// person.
const PRIMARY_ADMIN: Record<string, Row> = {
  "grant-admin": [
    deny("SELF_MODIFICATION"),
    OK,
    conflict("ALREADY_ADMIN"),
    deny("SELF_MODIFICATION"),
  ],
  "revoke-admin": [
    deny("SELF_MODIFICATION"),
    conflict("NOT_AN_ADMIN"),
    OK,
    deny("SELF_MODIFICATION"),
  ],
  deactivate: [deny("SELF_MODIFICATION"), OK, OK, deny("SELF_MODIFICATION")],
  delete: [deny("SELF_MODIFICATION"), OK, OK, deny("SELF_MODIFICATION")],
  "reset-mfa": [
    deny("PRIMARY_ADMIN_PROTECTED"),
    OK,
    OK,
    deny("PRIMARY_ADMIN_PROTECTED"),
  ],
  "update-profile": [OK, OK, OK, OK],
  "assign-position": [OK, OK, OK, OK],
  "initiate-transfer": [
    deny("SELF_MODIFICATION"),
    deny("TARGET_NOT_ELIGIBLE"),
    CREATED,
    deny("SELF_MODIFICATION"),
  ],
};

// The guard answers before any target is read, so these hold for every action
// and every target.
const ACTOR_LEVEL = {
  unauthenticated: { status: 401, code: "UNAUTHENTICATED" },
  user: deny("NOT_ADMIN"),
  adminNoMfa: deny("MFA_REQUIRED"),
  deactivatedAdmin: deny("ACTOR_INACTIVE"),
} as const satisfies Record<string, Expected>;

const AUTHZ_REASONS: readonly string[] = [
  "ACTOR_INACTIVE",
  "NOT_ADMIN",
  "SELF_MODIFICATION",
  "PRIMARY_ADMIN_PROTECTED",
  "PRIMARY_ADMIN_REQUIRED",
  "TARGET_NOT_ELIGIBLE",
  "NOT_TRANSFER_RECIPIENT",
  "NOT_TRANSFER_INITIATOR",
];

const authzSubject = (id: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id },
    select: { id: true, isAdmin: true, isPrimaryAdmin: true, status: true },
  });

const involved = (world: World) =>
  Object.values(world.targets).map((user) => user.id);

/** One request: the answer, the audit trail and, on a refusal, an untouched target. */
async function runCell({
  world,
  action,
  targetKey,
  expected,
  positionId,
  tracker,
  checkDrift,
  repeat = false,
}: {
  world: World;
  action: ActionDef;
  targetKey: TargetKey;
  expected: Expected;
  positionId: string;
  tracker: ReturnType<typeof auditTracker>;
  checkDrift: boolean;
  /** This action already succeeded on this very user earlier in the row. */
  repeat?: boolean;
}) {
  const label = `${world.kind} > ${action.name} > ${targetKey}`;
  const target = world.targets[targetKey];

  // Read before the call: a success changes the rows `can()` looks at.
  const decision = checkDrift
    ? can(
        await authzSubject(world.targets.self.id),
        action.authz,
        await authzSubject(target.id),
      )
    : null;
  const before = await snapshotUser(target.id);
  const transfersBefore = await prisma.primaryAdminTransfer.count();

  const result = await action.call(world.actor, target, { positionId });

  expect(result.status, label).toBe(expected.status);
  if (expected.code) expect(codeOf(result.body), label).toBe(expected.code);
  expectNoSecrets(result.body);

  if (decision) {
    const reason = expected.code ?? "";
    expect(decision, `${label} (can())`).toEqual(
      AUTHZ_REASONS.includes(reason)
        ? { allowed: false, reason }
        : { allowed: true },
    );
  }

  const rows = await tracker.fresh();
  if (expected.status < 300) {
    expect(
      rows.map((row) => row.type),
      label,
    ).toEqual(repeat ? [] : [action.audit]);
  } else {
    expect(rows, label).toEqual([]);
    expect(await snapshotUser(target.id), label).toEqual(before);
    expect(await prisma.primaryAdminTransfer.count(), label).toBe(
      transfersBefore,
    );
  }
}

beforeEach(() => {
  captured.clear();
});

describe("the matrix covers what authz.ts decides", () => {
  it("has a row for every action and a column for every target", () => {
    const names = ACTIONS.map((action) => action.name).sort();
    expect(Object.keys(ADMIN).sort()).toEqual(names);
    expect(Object.keys(PRIMARY_ADMIN).sort()).toEqual(names);
    expect(TARGET_KEYS).toHaveLength(4);
  });

  it("names every per-target action it leaves out, so a new one must be decided", () => {
    // Their endpoints are covered in src/lib/admin/users/handlers.db.test.ts
    // and their decisions in src/lib/authz.test.ts.
    const covered = new Set<UserAction>(ACTIONS.map((action) => action.authz));
    const left = USER_ACTIONS.filter((action) => !covered.has(action));
    expect([...left].sort()).toEqual(
      [
        "changeEmail",
        "reactivate",
        "resendInvite",
        "revokeSessions",
        "unassignPosition",
        "unlock",
      ].sort(),
    );
  });
});

describe.each([
  { kind: "admin", table: ADMIN },
  { kind: "primaryAdmin", table: PRIMARY_ADMIN },
] as const)("$kind over HTTP", ({ kind, table }) => {
  it.each(ACTIONS)(
    "$name",
    async (action) => {
      await withRollback(async () => {
        const world = await buildWorld(kind);
        const { id: positionId } = await createPosition();
        const tracker = auditTracker(() => involved(world));
        const row = table[action.name];
        // The Primary Admin's `self` and Primary Admin columns are one user. A
        // second identical write to the same user changes nothing, so the
        // handlers correctly write no audit row for it.
        const done = new Set<string>();
        for (const [index, targetKey] of TARGET_KEYS.entries()) {
          const targetId = world.targets[targetKey].id;
          await runCell({
            world,
            action,
            targetKey,
            expected: row[index],
            positionId,
            tracker,
            checkDrift: true,
            repeat: Boolean(action.idempotent) && done.has(targetId),
          });
          done.add(targetId);
        }
      });
    },
    120_000,
  );
});

describe.each(
  Object.entries(ACTOR_LEVEL).map(([kind, expected]) => ({ kind, expected })),
)("$kind", ({ kind, expected }) => {
  it("is refused every action on every target, and nothing changes", async () => {
    await withRollback(async () => {
      const world = await buildWorld(kind as keyof typeof ACTOR_LEVEL);
      const { id: positionId } = await createPosition();
      const tracker = auditTracker(() => involved(world));
      for (const action of ACTIONS) {
        for (const targetKey of TARGET_KEYS) {
          await runCell({
            world,
            action,
            targetKey,
            expected,
            positionId,
            tracker,
            checkDrift: false,
          });
        }
      }
    });
  }, 120_000);
});
