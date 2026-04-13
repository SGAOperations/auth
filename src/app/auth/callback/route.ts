import { NextRequest, NextResponse } from "next/server";
import { authErrorToQueryCode } from "@/lib/supabase/auth-errors";
import { getSafeNextPath } from "@/lib/supabase/next-redirect";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Auth callback for Supabase email (PKCE). Supabase redirects here with `code`
 * after the user follows the magic link.
 *
 * Optional query `next`: path-only post-login destination, set when building
 * `emailRedirectTo` (e.g. `${origin}/auth/callback?next=/dashboard`).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextPath = getSafeNextPath(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}?error=missing_code`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const codeParam = authErrorToQueryCode(error);
    return NextResponse.redirect(`${origin}?error=${codeParam}`);
  }

  return NextResponse.redirect(`${origin}${nextPath}`);
}
