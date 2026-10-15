import "server-only";
import { nextCookies } from "better-auth/next-js";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
import type { SignupAllowlist } from "@/lib/auth/signup-allowlist";

/**
 * The plugin list of the live auth instance. The audit coverage test builds
 * its endpoint table from the same list, so a plugin added here is covered.
 */
export function buildAuthPlugins(list: SignupAllowlist | null) {
  return [
    ...(list ? [signupAllowlist(list)] : []),
    // nextCookies must stay the last plugin.
    nextCookies(),
  ];
}
