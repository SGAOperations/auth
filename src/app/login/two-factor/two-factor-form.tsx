"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  normalizeTotpInput,
  verifyCodeSchema,
} from "@/lib/account/security-ui";
import { postSecondFactor } from "@/lib/auth/client";
import {
  AUTH_COPY,
  backupCodeFormSchema,
  isTerminalSecondFactorState,
  normalizeBackupCodeInput,
  secondFactorMessage,
  type SecondFactorMode,
  type SecondFactorState,
} from "@/lib/auth/forms";
import { cn } from "@/lib/utils";
import { completeSignIn } from "../actions";

const linkClass = "underline underline-offset-4 hover:text-foreground";

const backToSignIn = (
  <Link href="/login" className={linkClass}>
    Back to sign in
  </Link>
);

type TerminalState = Extract<
  SecondFactorState,
  "expired" | "too-many" | "locked"
>;

const ENDED_COPY: Record<
  TerminalState,
  { title: string; description: string }
> = {
  expired: {
    title: AUTH_COPY.secondFactorExpiredTitle,
    description: AUTH_COPY.secondFactorExpired,
  },
  "too-many": {
    title: AUTH_COPY.secondFactorExpiredTitle,
    description: AUTH_COPY.secondFactorTooMany,
  },
  locked: {
    title: AUTH_COPY.secondFactorLockedTitle,
    description: AUTH_COPY.secondFactorLocked,
  },
};

/** The challenge is over: the form is replaced by a way back to the start. */
export function TwoFactorEnded({ state }: { state: TerminalState }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    linkRef.current?.focus();
  }, []);
  const { title, description } = ENDED_COPY[state];
  return (
    <AuthShell
      title={title}
      description={description}
      footer={backToSignIn}
      requiresJs
    >
      <Link
        ref={linkRef}
        href="/login"
        className={cn(buttonVariants(), "w-full")}
      >
        {AUTH_COPY.signInAgain}
      </Link>
    </AuthShell>
  );
}

type CodeValues = { code: string };

// Links the field to the server's answer (and to its own validation message),
// which FormControl alone would not.
function CodeInput({
  field,
  mode,
  problem,
  disabled,
}: {
  field: ControllerRenderProps<CodeValues, "code">;
  mode: SecondFactorMode;
  problem: boolean;
  disabled: boolean;
}) {
  const { error, formMessageId } = useFormField();
  const describedBy = [
    problem && "second-factor-problem",
    error && formMessageId,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <FormControl>
      {mode === "totp" ? (
        <Input
          {...field}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="123456"
          disabled={disabled}
          aria-describedby={describedBy || undefined}
        />
      ) : (
        <Input
          {...field}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={16}
          placeholder="abcde-12345"
          disabled={disabled}
          aria-describedby={describedBy || undefined}
        />
      )}
    </FormControl>
  );
}

interface CodeStepProps {
  mode: SecondFactorMode;
  problem: SecondFactorState | null;
  onProblem: (state: SecondFactorState | null) => void;
  onEnded: (state: TerminalState) => void;
  onSwitch: () => void;
}

// Mounted once per mode, so switching modes clears the field and focuses the
// new one.
function CodeStep({
  mode,
  problem,
  onProblem,
  onEnded,
  onSwitch,
}: CodeStepProps) {
  const totp = mode === "totp";
  const form = useForm<CodeValues>({
    resolver: zodResolver(totp ? verifyCodeSchema : backupCodeFormSchema),
    defaultValues: { code: "" },
  });
  const [succeeded, setSucceeded] = useState(false);
  const { setFocus } = form;
  const pending = form.formState.isSubmitting || succeeded;

  useEffect(() => {
    setFocus("code");
  }, [setFocus]);

  async function submit(values: CodeValues) {
    onProblem(null);
    const code = totp
      ? normalizeTotpInput(values.code)
      : normalizeBackupCodeInput(values.code);
    const result = await postSecondFactor(mode, code);
    if (result.ok) {
      // Redirects; the button stays pending until the browser leaves.
      setSucceeded(true);
      await completeSignIn();
      return;
    }
    if (isTerminalSecondFactorState(result.state)) {
      onEnded(result.state as TerminalState);
      return;
    }
    onProblem(result.state);
    form.resetField("code");
    setFocus("code");
  }

  return (
    <AuthShell
      title={totp ? AUTH_COPY.totpTitle : AUTH_COPY.backupTitle}
      description={
        totp ? AUTH_COPY.totpDescription : AUTH_COPY.backupDescription
      }
      footer={backToSignIn}
      requiresJs
    >
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
                <FormLabel>
                  {totp ? AUTH_COPY.totpLabel : AUTH_COPY.backupLabel}
                </FormLabel>
                <CodeInput
                  field={field}
                  mode={mode}
                  problem={problem !== null}
                  disabled={pending}
                />
                {problem ? (
                  <p
                    id="second-factor-problem"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {secondFactorMessage(problem, mode)}
                  </p>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Verifying…" : "Verify"}
          </Button>
        </form>
      </Form>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={pending}
        onClick={onSwitch}
      >
        {totp ? AUTH_COPY.useBackupCode : AUTH_COPY.useAuthenticator}
      </Button>
    </AuthShell>
  );
}

// The second step of a password sign-in for an account with two-factor on. The
// signed `two_factor` challenge cookie set by the password step is what ties
// the code to the account; the verify endpoints check it.
export function TwoFactorForm() {
  const [mode, setMode] = useState<SecondFactorMode>("totp");
  const [problem, setProblem] = useState<SecondFactorState | null>(null);
  const [ended, setEnded] = useState<TerminalState | null>(null);

  if (ended) return <TwoFactorEnded state={ended} />;

  return (
    <CodeStep
      key={mode}
      mode={mode}
      problem={problem}
      onProblem={setProblem}
      onEnded={setEnded}
      onSwitch={() => {
        setProblem(null);
        setMode(mode === "totp" ? "backup" : "totp");
      }}
    />
  );
}
