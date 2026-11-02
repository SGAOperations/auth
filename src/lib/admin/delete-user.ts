import { emailConfirmed } from "@/lib/admin/transfer-view";

// Client-safe on purpose: no env, no DB, no `server-only`. The delete card and
// its tests share these helpers. Nothing here decides authority: the delete
// route does, and the deactivate-first rule is a UI step only.

export const DELETE_NEEDS_DEACTIVATION =
  "Deactivate this account before deleting it.";

/**
 * The line that explains a disabled delete control, or null when it is
 * enabled. The `can()` reason wins, so self and the Primary Admin keep their
 * own copy; otherwise only a deactivated user can be deleted from the page.
 */
export function deleteReason(
  authzReason: string | null,
  status: "ACTIVE" | "DEACTIVATED",
): string | null {
  if (authzReason !== null) return authzReason;
  return status === "ACTIVE" ? DELETE_NEEDS_DEACTIVATION : null;
}

export interface DeleteDialogCopy {
  title: string;
  consequences: string[];
  label: string;
}

export function deleteDialogCopy(name: string): DeleteDialogCopy {
  return {
    title: `Delete ${name} permanently?`,
    consequences: [
      "Remove their name and email.",
      "Remove their password, two-factor, passkeys and remembered devices.",
      "End every session and remove all of their positions.",
      "Keep their account ID, so products show them as 'Deleted user'.",
    ],
    label: "Delete account",
  };
}

/** Whether the confirm button is enabled: the email matches and nothing is running. */
export function canSubmitDelete(
  typed: string,
  email: string,
  pending: boolean,
): boolean {
  return !pending && emailConfirmed(typed, email);
}
