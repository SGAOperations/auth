import "server-only";
import { resolveCookiePolicy, sessionCookieName } from "@/lib/auth/cookies";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import {
  createDuplicateCookieGuard,
  DUPLICATE_COOKIE_GUARDED_PATHS,
} from "@/lib/security/duplicate-cookie";

export const withDuplicateCookieGuard = createDuplicateCookieGuard({
  cookieName: sessionCookieName(resolveCookiePolicy(env.SGAUTH_ENV)),
  paths: DUPLICATE_COOKIE_GUARDED_PATHS,
  log: logger,
});
