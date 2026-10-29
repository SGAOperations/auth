import type { UserStatus } from "@/generated/prisma/client";
import { canActOnTransfer, type AuthzSubject } from "@/lib/authz";
import { formatEt } from "@/lib/email/layout";
import {
  checkTransition,
  recipientIneligibility,
  type RecipientIneligibility,
} from "@/lib/jobs/pa-transfer-machine";
import { displayName } from "@/lib/user-display";

// Display logic for the Primary Admin transfer screens, as pure functions so it
// is tested without a browser. Nothing here decides authority: the transfer
// routes enforce it, and these functions only choose what to show.

export interface PartyName {
  name: string;
  preferredName: string | null;
}

export interface RecipientCandidate extends PartyName {
  id: string;
  email: string;
  status: UserStatus;
  twoFactorEnabled: boolean;
}

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: RecipientIneligibility };

/** The server's own rule, so the list can never disagree with what it accepts. */
export function recipientEligibility(
  candidate: Pick<RecipientCandidate, "id" | "status" | "twoFactorEnabled">,
  actorId: string,
): Eligibility {
  const reason = recipientIneligibility(
    { ...candidate, isAdmin: true },
    actorId,
  );
  return reason ? { eligible: false, reason } : { eligible: true };
}

export const REASON_COPY: Record<RecipientIneligibility, string> = {
  SELF: "You can't transfer to yourself",
  NOT_ADMIN: "Not an admin",
  DEACTIVATED: "Account is deactivated",
  NO_MFA: "Two-factor authentication isn't set up",
};

export interface RecipientOption {
  id: string;
  name: string;
  email: string;
  /** Null when the person can be chosen. */
  unavailableReason: string | null;
}

/** Eligible admins first, each group in the order given. */
export function recipientOptions(
  candidates: readonly RecipientCandidate[],
  actorId: string,
): RecipientOption[] {
  const options = candidates.map((candidate): RecipientOption => {
    const eligibility = recipientEligibility(candidate, actorId);
    return {
      id: candidate.id,
      name: displayName(candidate),
      email: candidate.email,
      unavailableReason: eligibility.eligible
        ? null
        : REASON_COPY[eligibility.reason],
    };
  });
  return [
    ...options.filter((option) => option.unavailableReason === null),
    ...options.filter((option) => option.unavailableReason !== null),
  ];
}

/** Whether what was typed is the recipient's email, exactly: case counts. */
export function emailConfirmed(typed: string, recipientEmail: string): boolean {
  return typed.trim() === recipientEmail;
}

export type TransferViewer = "sender" | "recipient";

const PERMISSION_COPY = "You don't have permission to do that.";

const ERROR_COPY: Record<string, string> = {
  CONFIRM_EMAIL_MISMATCH: "This doesn't match the recipient's email exactly.",
  TRANSFER_IN_FLIGHT: "A transfer is already in progress.",
  TRANSFER_INVALID_STATE:
    "This transfer can't be changed any more. Refresh to see where it stands.",
  TRANSFER_NOT_FOUND: "This transfer no longer exists.",
  RATE_LIMITED: "Too many attempts. Try again in a minute.",
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  MFA_REQUIRED: "Set up two-factor authentication to continue.",
  ACTOR_INACTIVE: PERMISSION_COPY,
  NOT_ADMIN: PERMISSION_COPY,
  PRIMARY_ADMIN_REQUIRED: PERMISSION_COPY,
  NOT_TRANSFER_INITIATOR: PERMISSION_COPY,
  NOT_TRANSFER_RECIPIENT: PERMISSION_COPY,
  SELF_MODIFICATION: PERMISSION_COPY,
  TARGET_NOT_ELIGIBLE: PERMISSION_COPY,
};

const GENERIC_ERROR = "Something went wrong. Nothing was changed.";

export const REAUTH_DECLINED_COPY =
  "Confirm it's you to continue. Nothing was changed.";

/** What to tell the person about a refusal the transfer routes can send. */
export function transferErrorCopy(
  code: string,
  reason: string | undefined,
  viewer: TransferViewer,
): string {
  if (code === "RECIPIENT_INELIGIBLE") {
    if (viewer === "recipient" && reason === "NO_MFA") {
      return "Set up two-factor authentication before accepting.";
    }
    const known = reason && Object.hasOwn(REASON_COPY, reason);
    return known
      ? `That person can't receive Primary Admin. ${REASON_COPY[reason as RecipientIneligibility]}.`
      : "That person can't receive Primary Admin.";
  }
  return Object.hasOwn(ERROR_COPY, code) ? ERROR_COPY[code] : GENERIC_ERROR;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `in 23 hours`, `in 2 days`, `3 minutes ago`: a coarse distance from `now`. */
export function relativeFrom(date: Date, now: Date): string {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < HOUR_MS) {
    return RELATIVE.format(Math.round(diff / MINUTE_MS), "minute");
  }
  if (abs < 2 * DAY_MS) {
    return RELATIVE.format(Math.round(diff / HOUR_MS), "hour");
  }
  return RELATIVE.format(Math.round(diff / DAY_MS), "day");
}

export interface InFlightTransfer {
  id: string;
  status: "PENDING_ACCEPTANCE" | "COOLING";
  fromUserId: string;
  toUserId: string;
  acceptanceExpiresAt: Date;
  executesAt: Date | null;
  fromUser: PartyName;
  toUser: PartyName;
}

export interface StatusCardView {
  title: string;
  description: string;
  canCancel: boolean;
  canAccept: boolean;
  canDecline: boolean;
}

/** What the dashboard card says and which buttons the viewer gets. */
export function statusCardView(
  transfer: InFlightTransfer,
  viewer: AuthzSubject,
  now: Date,
): StatusCardView {
  const from = displayName(transfer.fromUser);
  const to = displayName(transfer.toUser);
  const allowed = (action: "accept" | "decline" | "cancel") =>
    canActOnTransfer(viewer, transfer, action).allowed &&
    checkTransition(transfer, action, now).ok;

  const actions = {
    canCancel: allowed("cancel"),
    canAccept: allowed("accept"),
    canDecline: allowed("decline"),
  };

  if (transfer.status === "PENDING_ACCEPTANCE") {
    return {
      title: "Primary Admin transfer pending",
      description: `Waiting for ${to} to accept (expires ${formatEt(transfer.acceptanceExpiresAt)}).`,
      ...actions,
    };
  }
  const executesAt = transfer.executesAt;
  return {
    title: "Primary Admin transfer accepted",
    description: executesAt
      ? `${to} accepted. They become Primary Admin ${formatEt(executesAt)} (${relativeFrom(executesAt, now)}). ${from} can cancel until then.`
      : `${to} accepted. ${from} can cancel until it takes effect.`,
    ...actions,
  };
}

export interface RecentCompletion {
  id: string;
  completedAt: Date;
  fromUser: PartyName;
  toUser: PartyName;
}

export function completionBannerCopy(completion: RecentCompletion): string {
  return `${displayName(completion.toUser)} is now the Primary Admin (since ${formatEt(completion.completedAt)}). ${displayName(completion.fromUser)} remains an admin.`;
}

export const BANNER_STORAGE_PREFIX = "sgauth.pa-transfer-banner.";

export type AcceptStatus =
  | "PENDING_ACCEPTANCE"
  | "COOLING"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

export interface AcceptView {
  id: string;
  status: AcceptStatus;
  acceptanceExpiresAt: Date;
  executesAt: Date | null;
  fromUser: PartyName;
}

export type AcceptState =
  | { kind: "pending"; fromName: string; expiresAt: Date }
  | { kind: "cooling"; executesAt: Date | null }
  | { kind: "cancelled" }
  | { kind: "expired" }
  | { kind: "completed" };

/**
 * The state the recipient's page renders. A request past its deadline that the
 * scheduled job has not swept yet reads as expired, as the server would refuse it.
 */
export function acceptState(view: AcceptView, now: Date): AcceptState {
  switch (view.status) {
    case "PENDING_ACCEPTANCE":
      return now.getTime() >= view.acceptanceExpiresAt.getTime()
        ? { kind: "expired" }
        : {
            kind: "pending",
            fromName: displayName(view.fromUser),
            expiresAt: view.acceptanceExpiresAt,
          };
    case "COOLING":
      return { kind: "cooling", executesAt: view.executesAt };
    case "COMPLETED":
      return { kind: "completed" };
    case "CANCELLED":
      return { kind: "cancelled" };
    case "EXPIRED":
      return { kind: "expired" };
  }
}
