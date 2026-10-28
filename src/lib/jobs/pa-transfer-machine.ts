import type {
  PrimaryAdminTransferStatus,
  UserStatus,
} from "@/generated/prisma/client";

// The rules of a Primary Admin transfer, as pure data and functions. No
// `server-only`, no database: the service enforces them in a transaction, and
// the transfer UI imports the same constants and eligibility check.

/** How long the recipient has to accept (design: 7 days). */
export const ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The cooling period between acceptance and execution (design: 24 hours). */
export const COOLING_MS = 24 * 60 * 60 * 1000;

/**
 * What a person can do to a transfer. System transitions (execute, expire and
 * the ineligible-recipient cancel) are not here: the scheduled job selects its
 * rows by status inside its own row lock, and that stays its guard.
 */
export const TRANSFER_EVENTS = [
  "accept",
  "decline",
  "cancel",
  "cancelByToken",
] as const;

export type TransferEvent = (typeof TRANSFER_EVENTS)[number];

export const TRANSFER_STATUSES = [
  "PENDING_ACCEPTANCE",
  "COOLING",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
] as const satisfies readonly PrimaryAdminTransferStatus[];

type Transitions = {
  readonly [S in PrimaryAdminTransferStatus]: {
    readonly [E in TransferEvent]?: PrimaryAdminTransferStatus;
  };
};

// A status with no entry is terminal. Cancel stays open for the whole of
// COOLING, even past `executesAt`: the transfer is not done until the job runs,
// so the Primary Admin keeps the role, and the power to cancel, until then.
export const TRANSITIONS = {
  PENDING_ACCEPTANCE: {
    accept: "COOLING",
    decline: "CANCELLED",
    cancel: "CANCELLED",
  },
  COOLING: {
    decline: "CANCELLED",
    cancel: "CANCELLED",
    cancelByToken: "CANCELLED",
  },
  COMPLETED: {},
  CANCELLED: {},
  EXPIRED: {},
} as const satisfies Transitions;

export type TransitionResult =
  | { ok: true; to: PrimaryAdminTransferStatus }
  | { ok: false };

/**
 * Whether `event` is legal for the transfer at `now`. The one time rule: an
 * acceptance at or after `acceptanceExpiresAt` is refused, so a row the job has
 * not swept yet cannot still be accepted.
 */
export function checkTransition(
  transfer: { status: PrimaryAdminTransferStatus; acceptanceExpiresAt: Date },
  event: TransferEvent,
  now: Date,
): TransitionResult {
  const allowed: { [E in TransferEvent]?: PrimaryAdminTransferStatus } =
    TRANSITIONS[transfer.status];
  const to = allowed[event];
  if (!to) return { ok: false };
  if (
    event === "accept" &&
    now.getTime() >= transfer.acceptanceExpiresAt.getTime()
  ) {
    return { ok: false };
  }
  return { ok: true, to };
}

export type RecipientIneligibility =
  | "SELF"
  | "NOT_ADMIN"
  | "DEACTIVATED"
  | "NO_MFA";

/**
 * Why `candidate` cannot receive the Primary Admin role, or `null` when they
 * can. The first failing rule wins, in the order of the type.
 */
export function recipientIneligibility(
  candidate: {
    id: string;
    isAdmin: boolean;
    status: UserStatus;
    twoFactorEnabled: boolean;
  },
  initiatorId: string,
): RecipientIneligibility | null {
  if (candidate.id === initiatorId) return "SELF";
  if (!candidate.isAdmin) return "NOT_ADMIN";
  if (candidate.status !== "ACTIVE") return "DEACTIVATED";
  if (!candidate.twoFactorEnabled) return "NO_MFA";
  return null;
}
