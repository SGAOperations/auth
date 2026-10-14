import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseAuthEnv } from "@/lib/auth/settings";
import {
  GATE_COOKIE,
  GATE_MAX_AGE,
  GATE_PATH,
  clientIp,
  deriveGateKey,
  passwordMatches,
  safeNextPath,
  signGateCookie,
  unlockLimiter,
} from "@/lib/preview-gate";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

const formSchema = z.object({
  password: z.string().min(1).max(256),
  next: z.string().max(2048).optional(),
});

function requestOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function backToGate(
  request: NextRequest,
  error: "wrong" | "rate",
  next: string,
) {
  const target = new URL(GATE_PATH, request.url);
  target.searchParams.set("error", error);
  target.searchParams.set("next", next);
  return NextResponse.redirect(target, { status: 303, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  // Second process.env read for auth until src/lib/env.ts (AUTH-T07) exists.
  const settings = parseAuthEnv(process.env);
  if (!settings.previewGate) {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }

  if (requestOrigin(request) !== new URL(request.url).origin) {
    return new NextResponse(null, { status: 403, headers: NO_STORE });
  }

  const form = await request.formData();
  const raw = {
    password: form.get("password"),
    next: form.get("next") ?? undefined,
  };
  const next = safeNextPath(typeof raw.next === "string" ? raw.next : "/");

  const attempt = unlockLimiter.hit(clientIp(request.headers), Date.now());
  if (!attempt.allowed) return backToGate(request, "rate", next);

  const parsed = formSchema.safeParse(raw);
  if (
    !parsed.success ||
    !passwordMatches(parsed.data.password, settings.previewGate.password)
  ) {
    return backToGate(request, "wrong", next);
  }

  const key = deriveGateKey(settings.secret, settings.previewGate.password);
  const value = signGateCookie(key, Math.floor(Date.now() / 1000));
  const response = NextResponse.redirect(new URL(next, request.url), {
    status: 303,
    headers: NO_STORE,
  });
  response.cookies.set(GATE_COOKIE, value, {
    path: "/",
    maxAge: GATE_MAX_AGE,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  return response;
}
