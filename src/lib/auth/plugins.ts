import "server-only";
import { nextCookies } from "better-auth/next-js";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
import type { SignupAllowlist } from "@/lib/auth/signup-allowlist";

interface AuthPluginsInput {
  signupAllowlist: SignupAllowlist | null;
  prisma: PrismaClient;
  /** The environment's base URL, which is the JWT issuer. */
  issuer: string;
}

/**
 * The plugin list of the live auth instance. The audit coverage test builds
 * its endpoint table from the same list, so a plugin added here is covered.
 */
export function buildAuthPlugins({
  signupAllowlist: list,
  prisma,
  issuer,
}: AuthPluginsInput) {
  return [
    ...(list ? [signupAllowlist(list)] : []),
    buildJwtPlugin({ prisma, issuer }),
    // nextCookies must stay the last plugin.
    nextCookies(),
  ];
}
