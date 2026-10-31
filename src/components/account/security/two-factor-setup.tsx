"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type Ref } from "react";
import { useForm } from "react-hook-form";
import { BackupCodesPanel } from "@/components/account/security/backup-codes-panel";
import { PasswordActionForm } from "@/components/account/security/password-action-form";
import { useReauth } from "@/components/reauth-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  groupKey,
  normalizeTotpInput,
  parseEnableResponse,
  parseTotpUri,
  postSecurity,
  verifyCodeSchema,
  type SecurityError,
  type VerifyCodeValues,
} from "@/lib/account/security-ui";
import { cn } from "@/lib/utils";

interface TwoFactorSetupProps {
  email: string;
  isAdmin: boolean;
  /** The page was opened by the admin guard. */
  mfaRequiredReason: boolean;
}

type Step =
  | { name: "start" }
  | { name: "verify"; totpURI: string; backupCodes: string[] }
  | { name: "codes"; backupCodes: string[] }
  | { name: "done" };

const GENERIC_ERROR: SecurityError = {
  message: "Something went wrong. Try again.",
};

// Everything the flow holds is component state. Nothing is persisted on the
// client, and the codes are dropped as soon as they are acknowledged.
export function TwoFactorSetup({
  email,
  isAdmin,
  mfaRequiredReason,
}: TwoFactorSetupProps) {
  const router = useRouter();
  const reauth = useReauth();
  const [step, setStep] = useState<Step>({ name: "start" });
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const adminTools = isAdmin || mfaRequiredReason;

  useEffect(() => {
    if (mfaRequiredReason) cardRef.current?.scrollIntoView({ block: "start" });
  }, [mfaRequiredReason]);

  // After a step change, focus moves to the new step's heading.
  const stepName = step.name;
  useEffect(() => {
    if (stepName !== "start") headingRef.current?.focus();
  }, [stepName]);

  async function start(password: string): Promise<SecurityError | null> {
    const result = await postSecurity(
      reauth.fetch,
      "/api/auth/two-factor/enable",
      { password },
    );
    if (!result.ok) return result.error;
    const enabled = parseEnableResponse(result.body);
    if (!enabled) return GENERIC_ERROR;
    setStep({ name: "verify", ...enabled });
    return null;
  }

  const enrolled = step.name === "codes" || step.name === "done";

  return (
    <div ref={cardRef}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Two-factor authentication
            <Badge variant={enrolled ? "default" : "secondary"}>
              {enrolled ? "On" : "Off"}
            </Badge>
          </CardTitle>
          <CardDescription>
            {isAdmin
              ? "Required for admins. Add a second step at sign-in using an authenticator app."
              : "Add a second step at sign-in using an authenticator app such as Google Authenticator, Microsoft Authenticator, or 1Password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step.name === "start" ? (
            <PasswordActionForm
              submitLabel="Set up two-factor authentication"
              pendingLabel="Starting…"
              autoFocus={mfaRequiredReason}
              onSubmit={start}
            />
          ) : null}

          {step.name === "verify" ? (
            <VerifyStep
              ref={headingRef}
              totpURI={step.totpURI}
              onVerified={() =>
                setStep({ name: "codes", backupCodes: step.backupCodes })
              }
              onCancel={() => setStep({ name: "start" })}
            />
          ) : null}

          {step.name === "codes" ? (
            <BackupCodesPanel
              codes={step.backupCodes}
              email={email}
              mode="enrolled"
              onDone={() => {
                if (adminTools) setStep({ name: "done" });
                else router.refresh();
              }}
            />
          ) : null}

          {step.name === "done" ? (
            <div className="flex flex-col gap-4">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="text-base font-medium outline-none"
              >
                Two-factor authentication is on
              </h3>
              <div className="flex flex-wrap gap-2">
                <Link href="/admin" className={cn(buttonVariants())}>
                  Continue to admin tools
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.refresh()}
                >
                  Manage two-factor settings
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

interface VerifyStepProps {
  ref: Ref<HTMLHeadingElement>;
  totpURI: string;
  onVerified: () => void;
  onCancel: () => void;
}

function VerifyStep({ ref, totpURI, onVerified, onCancel }: VerifyStepProps) {
  const parsed = parseTotpUri(totpURI);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [formError, setFormError] = useState<SecurityError | null>(null);
  const [failures, setFailures] = useState(0);
  const form = useForm<VerifyCodeValues>({
    resolver: zodResolver(verifyCodeSchema),
    defaultValues: { code: "" },
  });
  const submitting = form.formState.isSubmitting;
  const { setFocus } = form;

  useEffect(() => {
    if (failures > 0 && !submitting) setFocus("code");
  }, [failures, submitting, setFocus]);

  if (!parsed) {
    return (
      <div className="flex flex-col gap-4">
        <h3
          ref={ref}
          tabIndex={-1}
          className="text-base font-medium outline-none"
        >
          Scan this QR code with your authenticator app
        </h3>
        <p role="alert" className="text-sm text-destructive">
          {GENERIC_ERROR.message}
        </p>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={onCancel}
        >
          Start over
        </Button>
      </div>
    );
  }

  async function copyKey(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  async function submit(values: VerifyCodeValues) {
    setFormError(null);
    const result = await postSecurity(
      (input, init) => fetch(input, init),
      "/api/auth/two-factor/verify-totp",
      { code: normalizeTotpInput(values.code) },
    );
    if (result.ok) {
      onVerified();
      return;
    }
    const error = result.error ?? GENERIC_ERROR;
    form.resetField("code", { defaultValue: "" });
    if (error.field === "code")
      form.setError("code", { message: error.message });
    else setFormError(error);
    setFailures((count) => count + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <h3
        ref={ref}
        tabIndex={-1}
        className="text-base font-medium outline-none"
      >
        Scan this QR code with your authenticator app
      </h3>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <QRCodeSVG
          value={totpURI}
          size={192}
          level="M"
          marginSize={2}
          bgColor="#ffffff"
          fgColor="#000000"
          title="QR code for your authenticator app"
          className="h-48 w-48 shrink-0 rounded-lg"
        />
        <details className="min-w-0 text-sm">
          <summary className="cursor-pointer">
            Can&apos;t scan it? Enter this key instead
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <code className="font-mono text-base break-all">
              {groupKey(parsed.secret)}
            </code>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copyKey(parsed.secret)}
              >
                Copy key
              </Button>
              <span role="status" className="text-muted-foreground">
                {copied === "copied" ? "Copied" : null}
                {copied === "failed" ? "Copy failed. Select the key." : null}
              </span>
            </div>
          </div>
        </details>
      </div>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(submit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>6-digit code from the app</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    placeholder="123456"
                    disabled={submitting}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Verifying…" : "Verify and turn on"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
