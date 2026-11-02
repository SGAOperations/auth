import { formatDateTime } from "@/lib/admin/format";

// Client-safe on purpose: no env, no DB, no `server-only`. The Email card and
// its tests share these helpers. Format checks stay on the server.

/** The address as the endpoint reads it: trimmed and lower-cased. */
export function normalizeDraft(draft: string): string {
  return draft.trim().toLowerCase();
}

/** Why the draft can't be sent, or null when it can. */
export function submitBlockReason(
  current: string,
  draft: string,
): string | null {
  const next = normalizeDraft(draft);
  if (next === "") return "Enter the new address.";
  if (next === normalizeDraft(current)) {
    return "That is already this user's email address.";
  }
  return null;
}

export interface EmailConfirmCopy {
  title: string;
  description: string;
  label: string;
}

export function confirmCopy(
  name: string,
  current: string,
  next: string,
): EmailConfirmCopy {
  return {
    title: `Send a verification link to ${next}?`,
    description: `${name}'s address stays ${current} until they open the link. It lasts 24 hours. Any earlier pending request is cancelled.`,
    label: "Send link",
  };
}

export function pendingLine(
  pending: { newEmail: string; expiresAt: string },
  current: string,
): string {
  return `Waiting for ${pending.newEmail} to confirm. The link expires ${formatDateTime(pending.expiresAt)}. Until then, ${current} keeps working. Sending another link replaces this one.`;
}

export function successToast(next: string): string {
  return `Verification link sent to ${next}.`;
}
