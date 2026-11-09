import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import {
  consentReturnCookieName,
  stateCookieName,
  stateCookieSecure,
} from "@/lib/slack/oauth-state";
import { finishSlackProfileAccess } from "@/lib/slack/profile-access";
import { slackLoginResultPath, slackResultPath } from "@/lib/slack/result";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const callbackQuery = z.object({
  state: z.string().min(1).max(128),
  code: z.string().min(1).max(512),
});

// Slack sends the browser back here after the title-update consent (#358). A
// GET because that is how an OAuth redirect arrives; the single-use state row,
// bound to the signed-in user and to this browser's cookie, is what makes it
// safe, as for /account/slack/callback. Writes SLACK_TOKEN_GRANTED
// (src/lib/slack/profile-access.ts).
export async function GET(request: NextRequest) {
  // The consent started from the /login interstitial (#361) says so in a
  // cookie; it only selects between two fixed internal paths.
  const fromLogin = z
    .literal("login")
    .safeParse(request.cookies.get(consentReturnCookieName())?.value).success;
  const resultPath = fromLogin ? slackLoginResultPath : slackResultPath;

  const back = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url), 303);
    // Set rather than delete(): a __Host- cookie is only cleared by a
    // Set-Cookie that is itself Secure with path=/.
    for (const name of [
      stateCookieName("consent"),
      consentReturnCookieName(),
    ]) {
      response.cookies.set(name, "", {
        httpOnly: true,
        secure: stateCookieSecure(),
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
    }
    return response;
  };

  const user = await getCurrentUser();
  if (!user) return back(`/login?redirect=${encodeURIComponent("/account")}`);
  if (await limitRequest("slackLink", user.id)) {
    return back(resultPath("rate_limited"));
  }

  const params = request.nextUrl.searchParams;
  // Slack sends `error=access_denied` instead of a code when the person cancels.
  if (params.get("error") === "access_denied") {
    return back(resultPath("consent_declined"));
  }
  const query = callbackQuery.safeParse({
    state: params.get("state"),
    code: params.get("code"),
  });
  if (!query.success) return back(resultPath("failed"));

  const outcome = await finishSlackProfileAccess(user.id, {
    ...query.data,
    cookieState: (await cookies()).get(stateCookieName("consent"))?.value,
  });
  return back(resultPath(outcome));
}
