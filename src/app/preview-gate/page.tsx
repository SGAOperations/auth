import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseAuthEnv } from "@/lib/auth/settings";
import {
  GATE_COOKIE,
  UNLOCK_PATH,
  deriveGateKey,
  nowSeconds,
  safeNextPath,
  verifyGateCookie,
} from "@/lib/preview-gate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SGAuth test environment",
  robots: { index: false, follow: false },
};

const searchParamsSchema = z.object({
  next: z.string().max(2048).optional(),
  error: z.enum(["wrong", "rate"]).optional(),
});

const ERROR_COPY = {
  wrong: "That password isn't right.",
  rate: "Too many attempts. Try again in a few minutes.",
} as const;

export default async function PreviewGatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Second process.env read for auth until src/lib/env.ts (AUTH-T07) exists.
  const settings = parseAuthEnv(process.env);
  if (!settings.previewGate) notFound();

  const parsed = searchParamsSchema.safeParse(await searchParams);
  const { next, error } = parsed.success ? parsed.data : {};
  const target = safeNextPath(next);

  const key = deriveGateKey(settings.secret, settings.previewGate.password);
  const cookie = (await cookies()).get(GATE_COOKIE)?.value;
  if (verifyGateCookie(key, cookie, nowSeconds())) {
    redirect(target);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>SGAuth test environment</CardTitle>
          <CardDescription>
            This is a pre-production copy of SGAuth. Enter the access password
            to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action={UNLOCK_PATH}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="next" value={target} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Access password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                aria-describedby={error ? "password-error" : undefined}
              />
              {error ? (
                <p
                  id="password-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {ERROR_COPY[error]}
                </p>
              ) : null}
            </div>
            <Button type="submit">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
