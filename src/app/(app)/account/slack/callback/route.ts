import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import { slackResultPath } from "@/lib/slack/result";
import {
  finishSlackConnect,
  slackStateCookieName,
  slackStateCookieSecure,
} from "@/lib/slack/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Slack sends the browser back here after Connect Slack (#314). A GET because
// that is how an OAuth redirect arrives; the state cookie, which only a
// same-site navigation from Slack's redirect carries, and the single-use state
// row are what make it safe. Writes SLACK_LINKED (src/lib/slack/service.ts).
export async function GET(request: NextRequest) {
  const back = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url), 303);
    // Set rather than delete(): a __Host- cookie is only cleared by a
    // Set-Cookie that is itself Secure with path=/.
    response.cookies.set(slackStateCookieName(), "", {
      httpOnly: true,
      secure: slackStateCookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  };

  const user = await getCurrentUser();
  if (!user) return back(`/login?redirect=${encodeURIComponent("/account")}`);
  if (await limitRequest("slackLink", user.id)) {
    return back(slackResultPath("rate_limited"));
  }

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  // Slack sends `error` instead of a code when the person cancels.
  if (!state || !code || state.length > 128 || code.length > 512) {
    return back(slackResultPath("failed"));
  }

  const outcome = await finishSlackConnect(user.id, {
    state,
    code,
    cookieState: (await cookies()).get(slackStateCookieName())?.value,
  });
  return back(slackResultPath(outcome));
}
