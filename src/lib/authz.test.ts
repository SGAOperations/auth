import { describe, expect, it } from "vitest";
import {
  GLOBAL_ACTIONS,
  USER_ACTIONS,
  can,
  canActOnTransfer,
  canUpdateOwnProfile,
  canViewOrgChart,
  type AuthzDenialReason,
  type AuthzSubject,
  type UserAction,
} from "./authz";

const subject = (
  id: string,
  overrides: Partial<AuthzSubject> = {},
): AuthzSubject => ({
  id,
  isAdmin: false,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  ...overrides,
});

const user = subject("user");
const otherUser = subject("other-user");
const admin = subject("admin", { isAdmin: true });
const otherAdmin = subject("other-admin", { isAdmin: true });
const pa = subject("pa", { isAdmin: true, isPrimaryAdmin: true });
const deactivatedAdmin = subject("deactivated-admin", {
  isAdmin: true,
  status: "DEACTIVATED",
});

const actors = { user, admin, pa, deactivatedAdmin };
type ActorName = keyof typeof actors;

// Target columns, in order: self, other user, other admin, primary admin.
const TARGETS = ["self", "other user", "other admin", "primary admin"] as const;
type Expected = "allow" | AuthzDenialReason;
type Row = readonly [Expected, Expected, Expected, Expected];

function targetsFor(actor: AuthzSubject) {
  return [actor, otherUser, otherAdmin, pa] as const;
}

const all = (value: Expected): Row => [value, value, value, value];

const NOT_ADMIN_ROW = all("NOT_ADMIN");
const INACTIVE_ROW = all("ACTOR_INACTIVE");

const adminSelfProtected: Row = [
  "SELF_MODIFICATION",
  "allow",
  "allow",
  "PRIMARY_ADMIN_PROTECTED",
];
const paSelfProtected: Row = [
  "SELF_MODIFICATION",
  "allow",
  "allow",
  "SELF_MODIFICATION",
];

// The ticket's matrix: actor x action x target, written out literally.
const MATRIX: Record<ActorName, Partial<Record<UserAction, Row>>> = {
  user: Object.fromEntries(USER_ACTIONS.map((a) => [a, NOT_ADMIN_ROW])),
  deactivatedAdmin: Object.fromEntries(
    USER_ACTIONS.map((a) => [a, INACTIVE_ROW]),
  ),
  admin: {
    grantAdmin: adminSelfProtected,
    revokeAdmin: adminSelfProtected,
    deactivate: adminSelfProtected,
    reactivate: adminSelfProtected,
    delete: adminSelfProtected,
    assignPosition: all("allow"),
    unassignPosition: all("allow"),
    updateProfile: all("allow"),
    revokeSessions: all("allow"),
    unlock: all("allow"),
    resendInvite: all("allow"),
    changeEmail: [
      "PRIMARY_ADMIN_REQUIRED",
      "allow",
      "PRIMARY_ADMIN_REQUIRED",
      "PRIMARY_ADMIN_PROTECTED",
    ],
    resetMfa: [
      "PRIMARY_ADMIN_REQUIRED",
      "allow",
      "PRIMARY_ADMIN_REQUIRED",
      "PRIMARY_ADMIN_PROTECTED",
    ],
    initiateTransfer: [
      "SELF_MODIFICATION",
      "PRIMARY_ADMIN_REQUIRED",
      "PRIMARY_ADMIN_REQUIRED",
      "PRIMARY_ADMIN_REQUIRED",
    ],
  },
  pa: {
    grantAdmin: paSelfProtected,
    revokeAdmin: paSelfProtected,
    deactivate: paSelfProtected,
    reactivate: paSelfProtected,
    delete: paSelfProtected,
    assignPosition: all("allow"),
    unassignPosition: all("allow"),
    updateProfile: all("allow"),
    revokeSessions: all("allow"),
    unlock: all("allow"),
    resendInvite: all("allow"),
    changeEmail: all("allow"),
    resetMfa: [
      "PRIMARY_ADMIN_PROTECTED",
      "allow",
      "allow",
      "PRIMARY_ADMIN_PROTECTED",
    ],
    initiateTransfer: [
      "SELF_MODIFICATION",
      "TARGET_NOT_ELIGIBLE",
      "allow",
      "SELF_MODIFICATION",
    ],
  },
};

const cases = (Object.keys(MATRIX) as ActorName[]).flatMap((actorName) =>
  USER_ACTIONS.flatMap((action) => {
    const row = MATRIX[actorName][action];
    if (!row) {
      throw new Error(`MATRIX is missing ${actorName} > ${action}`);
    }
    const targets = targetsFor(actors[actorName]);
    return TARGETS.map((targetName, i) => ({
      name: `${actorName} > ${action} > ${targetName}`,
      actor: actors[actorName],
      action,
      target: targets[i],
      expected: row[i],
    }));
  }),
);

describe("can(): actor x action x target matrix", () => {
  it("covers every user action for every actor and target", () => {
    expect(cases).toHaveLength(
      Object.keys(actors).length * USER_ACTIONS.length * TARGETS.length,
    );
  });

  it.each(cases)("$name", ({ actor, action, target, expected }) => {
    expect(can(actor, action, target)).toEqual(
      expected === "allow"
        ? { allowed: true }
        : { allowed: false, reason: expected },
    );
  });
});

describe("can(): global actions", () => {
  const deletedAdmin = subject("deleted-admin", {
    isAdmin: true,
    status: "DELETED",
  });

  it.each(GLOBAL_ACTIONS)("%s is allowed for admins and the PA", (action) => {
    expect(can(admin, action)).toEqual({ allowed: true });
    expect(can(pa, action)).toEqual({ allowed: true });
  });

  it.each(GLOBAL_ACTIONS)("%s is denied to non-admins", (action) => {
    expect(can(user, action)).toEqual({ allowed: false, reason: "NOT_ADMIN" });
  });

  it.each(GLOBAL_ACTIONS)("%s is denied to inactive actors", (action) => {
    for (const actor of [deactivatedAdmin, deletedAdmin]) {
      expect(can(actor, action)).toEqual({
        allowed: false,
        reason: "ACTOR_INACTIVE",
      });
    }
  });
});

describe("can(): edge cases", () => {
  it("denies a transfer to a deactivated admin", () => {
    expect(can(pa, "initiateTransfer", deactivatedAdmin)).toEqual({
      allowed: false,
      reason: "TARGET_NOT_ELIGIBLE",
    });
  });

  it("denies a row that is flagged primary admin but not admin", () => {
    const impossible = subject("impossible", { isPrimaryAdmin: true });
    expect(can(impossible, "grantAdmin", otherUser)).toEqual({
      allowed: false,
      reason: "NOT_ADMIN",
    });
  });

  it("throws, rather than denies, when a user action has no target", () => {
    expect(() =>
      // @ts-expect-error a user action requires a target; this is the runtime guard
      can(admin, "deactivate"),
    ).toThrow("can(): deactivate requires a target");
  });
});

describe("canActOnTransfer()", () => {
  const initiatorPa = subject("from", { isAdmin: true, isPrimaryAdmin: true });
  // The sender after another path (break-glass) took the role from them.
  const initiatorNoLongerPa = subject("from", { isAdmin: true });
  const recipient = subject("to", { isAdmin: true });
  const thirdAdmin = subject("third", { isAdmin: true });
  const deactivatedRecipient = subject("to", {
    isAdmin: true,
    status: "DEACTIVATED",
  });
  const recipientNoLongerAdmin = subject("to");
  const transfer = { fromUserId: "from", toUserId: "to" };

  const actors = {
    "the initiating Primary Admin": initiatorPa,
    "an initiator who is no longer Primary Admin": initiatorNoLongerPa,
    "the recipient": recipient,
    "a third admin": thirdAdmin,
    "a deactivated recipient": deactivatedRecipient,
    "a recipient who lost admin": recipientNoLongerAdmin,
  } as const;
  type ActorName = keyof typeof actors;
  type Outcome = "allow" | AuthzDenialReason;

  const EXPECTED: Record<
    ActorName,
    Record<"accept" | "decline" | "cancel", Outcome>
  > = {
    "the initiating Primary Admin": {
      accept: "NOT_TRANSFER_RECIPIENT",
      decline: "NOT_TRANSFER_RECIPIENT",
      cancel: "allow",
    },
    "an initiator who is no longer Primary Admin": {
      accept: "NOT_TRANSFER_RECIPIENT",
      decline: "NOT_TRANSFER_RECIPIENT",
      cancel: "NOT_TRANSFER_INITIATOR",
    },
    "the recipient": {
      accept: "allow",
      decline: "allow",
      cancel: "NOT_TRANSFER_INITIATOR",
    },
    "a third admin": {
      accept: "NOT_TRANSFER_RECIPIENT",
      decline: "NOT_TRANSFER_RECIPIENT",
      cancel: "NOT_TRANSFER_INITIATOR",
    },
    "a deactivated recipient": {
      accept: "ACTOR_INACTIVE",
      decline: "ACTOR_INACTIVE",
      cancel: "ACTOR_INACTIVE",
    },
    "a recipient who lost admin": {
      accept: "NOT_ADMIN",
      decline: "NOT_ADMIN",
      cancel: "NOT_ADMIN",
    },
  };

  const cases = (Object.keys(EXPECTED) as ActorName[]).flatMap((name) =>
    (["accept", "decline", "cancel"] as const).map(
      (action) => [name, action, EXPECTED[name][action]] as const,
    ),
  );

  it.each(cases)("%s > %s: %s", (name, action, expected) => {
    expect(canActOnTransfer(actors[name], transfer, action)).toEqual(
      expected === "allow"
        ? { allowed: true }
        : { allowed: false, reason: expected },
    );
  });
});

describe("canUpdateOwnProfile", () => {
  it("lets an active user edit their own profile", () => {
    expect(canUpdateOwnProfile(user, user.id)).toEqual({ allowed: true });
  });

  it("denies editing another user's profile", () => {
    expect(canUpdateOwnProfile(user, otherUser.id)).toEqual({
      allowed: false,
      reason: "NOT_SELF",
    });
  });

  it("does not let an admin use it on someone else", () => {
    expect(canUpdateOwnProfile(admin, otherUser.id)).toEqual({
      allowed: false,
      reason: "NOT_SELF",
    });
  });

  it("denies an inactive actor, even on their own profile", () => {
    expect(canUpdateOwnProfile(deactivatedAdmin, deactivatedAdmin.id)).toEqual({
      allowed: false,
      reason: "ACTOR_INACTIVE",
    });
  });
});

describe("canViewOrgChart", () => {
  it("lets an active non-admin view the chart", () => {
    expect(canViewOrgChart(user)).toEqual({ allowed: true });
  });

  it("lets an active admin view the chart", () => {
    expect(canViewOrgChart(admin)).toEqual({ allowed: true });
  });

  it("denies deactivated and deleted actors", () => {
    for (const status of ["DEACTIVATED", "DELETED"] as const) {
      expect(canViewOrgChart(subject("gone", { status }))).toEqual({
        allowed: false,
        reason: "ACTOR_INACTIVE",
      });
    }
  });
});

describe("can(): test coverage of the action list", () => {
  it("has a matrix row for every user action, so a new action cannot ship untested", () => {
    for (const actorName of Object.keys(MATRIX) as ActorName[]) {
      for (const action of USER_ACTIONS) {
        expect(
          MATRIX[actorName][action],
          `${actorName} > ${action}`,
        ).toBeDefined();
      }
    }
  });
});
