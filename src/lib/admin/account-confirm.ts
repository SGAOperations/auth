// Client-safe on purpose: no env, no DB, no `server-only`. The account actions
// card and its tests share these helpers.

export type ConfirmTarget = "grantAdmin" | "revokeAdmin" | "deactivate";

/** Which way the Administrator switch goes, from the state it is in now. */
export function adminTarget(isAdmin: boolean): ConfirmTarget {
  return isAdmin ? "revokeAdmin" : "grantAdmin";
}

export interface ConfirmCopy {
  title: string;
  description: string;
  label: string;
  destructive: boolean;
}

export function confirmCopy(target: ConfirmTarget, name: string): ConfirmCopy {
  switch (target) {
    case "grantAdmin":
      return {
        title: `Grant admin access to ${name}?`,
        description:
          "They'll be able to manage users, positions, and products.",
        label: "Grant admin access",
        destructive: false,
      };
    case "revokeAdmin":
      return {
        title: `Remove admin access from ${name}?`,
        description: "They'll no longer be able to manage SGAuth.",
        label: "Remove admin access",
        destructive: true,
      };
    case "deactivate":
      return {
        title: `Deactivate ${name}?`,
        description:
          "They'll be signed out everywhere immediately and can't sign in until reactivated.",
        label: "Deactivate",
        destructive: true,
      };
  }
}

/**
 * Whether the dialog is open is kept apart from what it confirms. The target is
 * frozen when the dialog opens and kept through the close, so the copy never
 * follows data that refreshes underneath it.
 */
export interface ConfirmState {
  open: boolean;
  target: ConfirmTarget | null;
}

export const CONFIRM_CLOSED: ConfirmState = { open: false, target: null };

export type ConfirmEvent =
  | { type: "open"; target: ConfirmTarget }
  | { type: "dismiss" }
  | { type: "confirm" }
  | { type: "settled" };

export function confirmReducer(
  state: ConfirmState,
  event: ConfirmEvent,
): ConfirmState {
  switch (event.type) {
    case "open":
      return { open: true, target: event.target };
    case "dismiss":
    case "confirm":
      return { open: false, target: state.target };
    case "settled":
      // A late settle never closes a dialog that was opened afterwards.
      return state.open ? state : CONFIRM_CLOSED;
  }
}
