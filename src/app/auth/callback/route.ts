import { NextRequest, NextResponse } from "next/server";

/**
 * Auth callback route for Supabase OTP/magic link verification.
 * Supabase redirects here with a `code` param after the user
 * clicks the magic link or enters an OTP
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}?error=missing_code`);
  }

  // TODO: Exchange code for a session via supabase

  return NextResponse.redirect(origin);
}
