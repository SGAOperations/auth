import { REAUTH_ERROR_CODES } from "@/lib/auth/reauth-policy";

// Client-safe: no env, no DB. The copy and error mapping of the passkey login
// button and the account security card, kept apart from the components so the
// rules are tested in one place.

export const PASSKEY_COPY = {
  signInButton: "Sign in with a passkey",
  signInPending: "Waiting for your passkey…",
  signInFailed:
    "That passkey couldn't be used. Try again, or sign in with your password.",
  rateLimited: "Too many attempts. Wait a minute and try again.",
  cardDescription:
    "Sign in with your fingerprint, face, screen lock, or a security key instead of your password. Your password still works.",
  adminNote:
    "Passkeys don't replace two-factor authentication for admin access.",
  empty: "You haven't added a passkey yet.",
  unnamed: "Unnamed passkey",
  synced: "Synced",
  limitReached:
    "You've reached the limit of 10 passkeys. Remove one to add another.",
  unsupported: "This browser doesn't support passkeys.",
  added: "Passkey added.",
  removed: "Passkey removed.",
  renamed: "Passkey renamed.",
  alreadyOnDevice: "This device already has a passkey for your account.",
  addFailed: "Couldn't add the passkey. Try again.",
  signInAgain: "For security, sign in again, then add your passkey.",
  updateFailed: "Something went wrong. Try again.",
} as const;

export type PasskeyFlowOutcome =
  | { kind: "silent" }
  | { kind: "message"; message: string };

interface ClientError {
  code?: string;
  message?: string;
  status?: number;
}

// What the browser ceremony reports when the person dismisses the prompt, it
// times out, or a newer ceremony replaces it. Not errors worth showing.
const CEREMONY_CANCELLED_CODES: readonly string[] = [
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
];

function isCancelled(error: ClientError): boolean {
  return (
    error.code !== undefined && CEREMONY_CANCELLED_CODES.includes(error.code)
  );
}

/** A failed passkey sign-in: nothing for a cancel, one line for the rest. */
export function mapPasskeySignInError(error: ClientError): PasskeyFlowOutcome {
  if (isCancelled(error)) return { kind: "silent" };
  if (error.status === 429) {
    return { kind: "message", message: PASSKEY_COPY.rateLimited };
  }
  return { kind: "message", message: PASSKEY_COPY.signInFailed };
}

// What is left of a REAUTH_REQUIRED once `withReauthRetry` has returned it: the
// person cancelled the re-auth prompt, so there is nothing to report.
function isReauthCancelled(error: ClientError): boolean {
  return error.code === REAUTH_ERROR_CODES.REAUTH_REQUIRED.code;
}

/** A failed rename or removal. */
export function mapManagePasskeyError(error: ClientError): PasskeyFlowOutcome {
  if (isReauthCancelled(error)) return { kind: "silent" };
  return { kind: "message", message: PASSKEY_COPY.updateFailed };
}

/** A failed enrollment. A cancelled prompt is quiet. */
export function mapAddPasskeyError(error: ClientError): PasskeyFlowOutcome {
  if (error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return { kind: "message", message: PASSKEY_COPY.alreadyOnDevice };
  }
  if (isCancelled(error) || isReauthCancelled(error)) {
    return { kind: "silent" };
  }
  if (error.code === "SESSION_NOT_FRESH") {
    return { kind: "message", message: PASSKEY_COPY.signInAgain };
  }
  if (error.code === "PASSKEY_LIMIT_REACHED") {
    return { kind: "message", message: PASSKEY_COPY.limitReached };
  }
  if (error.status === 429) {
    return { kind: "message", message: PASSKEY_COPY.rateLimited };
  }
  return { kind: "message", message: PASSKEY_COPY.addFailed };
}

type Result = { error: ClientError | null };

/**
 * Runs `call`, and when the server answers 403 `REAUTH_REQUIRED` opens the
 * re-auth prompt and runs it once more. A second `REAUTH_REQUIRED`, or a
 * cancelled prompt, goes back to the caller as it is, with no loop.
 */
export async function withReauthRetry<T extends Result>(
  call: () => Promise<T>,
  prompt: () => Promise<boolean>,
): Promise<T> {
  const first = await call();
  if (first.error?.code !== REAUTH_ERROR_CODES.REAUTH_REQUIRED.code) {
    return first;
  }
  if (!(await prompt())) return first;
  return call();
}

const ADDED_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Added Oct 28, 2026". UTC, so the server and the browser print the same. */
export function addedLabel(createdAt: Date | string): string {
  return `Added ${ADDED_FORMAT.format(new Date(createdAt))}`;
}

export function removeConfirmation(name: string | null): string {
  const label = name ?? PASSKEY_COPY.unnamed;
  return `Remove "${label}"? You won't be able to sign in with it anymore. Your password and any other passkeys still work.`;
}
