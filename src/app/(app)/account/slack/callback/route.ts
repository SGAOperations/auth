import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import { slackLoginResultPath, slackResultPath } from "@/lib/slack/result";
import {
  slackReturnCookieName,
  stateCookieName,
  stateCookieSecure,
} from "@/lib/slack/oauth-state";
import { finishSlackConnect } from "@/lib/slack/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Slack sends the browser back here after Connect Slack (#314). A GET because
// that is how an OAuth redirect arrives; the state cookie, which only a
// same-site navigation from Slack's redirect carries, and the single-use state
// row are what make it safe. Writes SLACK_LINKED (src/lib/slack/service.ts).
export async function GET(request: NextRequest) {
  // A flow started from the /login interstitial (#361) says so in a cookie; it
  // only selects between two fixed internal paths.
  const fromLogin = z
    .literal("login")
    .safeParse(request.cookies.get(slackReturnCookieName())?.value).success;
  const resultPath = fromLogin ? slackLoginResultPath : slackResultPath;

  const back = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url), 303);
    // Set rather than delete(): a __Host- cookie is only cleared by a
    // Set-Cookie that is itself Secure with path=/.
    for (const name of [stateCookieName("connect"), slackReturnCookieName()]) {
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
  const state = params.get("state");
  const code = params.get("code");
  // Slack sends `error` instead of a code when the person cancels.
  if (!state || !code || state.length > 128 || code.length > 512) {
    return back(resultPath("failed"));
  }

  const outcome = await finishSlackConnect(user.id, {
    state,
    code,
    cookieState: (await cookies()).get(stateCookieName("connect"))?.value,
  });
  return back(resultPath(outcome));
}
