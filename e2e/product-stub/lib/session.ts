import "server-only";
import {
  createSgauthClient,
  loginUrl,
  type SgaSession,
} from "@nusgaops/sgauth";
import { RETURN_TO_HEADER } from "@nusgaops/sgauth/proxy";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { config } from "./config";

// The SDK's default client keeps a 60 s cache. The stub builds its own with a
// 1 s TTL (negative entries are capped at the same value), so a position or an
// expiry changed in the database shows up within about a second.
const client = createSgauthClient({
  baseUrl: config.sgauthUrl,
  cookieName: config.cookieName,
  cacheTtlSeconds: config.cacheTtlSeconds,
});

/** The session for this request, or `null`. One lookup per render pass. */
export const getServerSession = cache(
  async (): Promise<SgaSession | null> =>
    client.getSession({ headers: await headers() }),
);

/** The session, or a redirect to SGAuth sign-in that returns to this URL. */
export async function requireSession(): Promise<SgaSession> {
  const session = await getServerSession();
  if (session !== null) return session;
  const returnTo = (await headers()).get(RETURN_TO_HEADER) ?? undefined;
  return redirect(loginUrl(returnTo, { baseUrl: config.sgauthUrl }));
}
