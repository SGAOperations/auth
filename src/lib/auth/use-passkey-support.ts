import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};
const supportsWebAuthn = () =>
  typeof window !== "undefined" && "PublicKeyCredential" in window;

/**
 * Whether this browser can run a WebAuthn ceremony. False on the server and
 * during hydration, so the first client render matches the server HTML.
 */
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(noSubscription, supportsWebAuthn, () => false);
}
