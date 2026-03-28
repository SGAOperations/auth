import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Auth callback route for Supabase OTP/magic link verification.
 * Supabase redirects here with a `code` param after the user
 * clicks the magic link or enters an OTP
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}?error=missing_code`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}?error=${encodeURIComponent(error.message)}`,
    );
  }

  const safeNext = next.startsWith("/") ? next : `/${next}`;
  return NextResponse.redirect(`${origin}${safeNext}`);
}
