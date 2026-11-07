import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import { stateCookieName, stateCookieSecure } from "@/lib/slack/oauth-state";
import { finishSlackProfileAccess } from "@/lib/slack/profile-access";
import { slackResultPath } from "@/lib/slack/result";

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
  const back = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url), 303);
    // Set rather than delete(): a __Host- cookie is only cleared by a
    // Set-Cookie that is itself Secure with path=/.
    response.cookies.set(stateCookieName("consent"), "", {
      httpOnly: true,
      secure: stateCookieSecure(),
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
  // Slack sends `error=access_denied` instead of a code when the person cancels.
  if (params.get("error") === "access_denied") {
    return back(slackResultPath("consent_declined"));
  }
  const query = callbackQuery.safeParse({
    state: params.get("state"),
    code: params.get("code"),
  });
  if (!query.success) return back(slackResultPath("failed"));

  const outcome = await finishSlackProfileAccess(user.id, {
    ...query.data,
    cookieState: (await cookies()).get(stateCookieName("consent"))?.value,
  });
  return back(slackResultPath(outcome));
}
