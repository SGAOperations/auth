"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
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
  EMAIL_CODE_LENGTH,
  emailCodeMessage,
  emailCodeRequestSchema,
  emailCodeVerifySchema,
  type EmailCodeErrorState,
  type EmailCodeRequestValues,
} from "@/lib/auth/forms";
import { requestCode, verifyCode, type EmailCodeFailure } from "./actions";

const linkClass = "underline underline-offset-4 hover:text-foreground";

/** Seconds before "Send a new code" is offered again. */
const RESEND_COOLDOWN_SECONDS = 60;

const codeFieldSchema = emailCodeVerifySchema.pick({ otp: true });
type CodeFieldValues = { otp: string };

const passwordInstead = (
  <Link href="/login" className={linkClass}>
    Sign in with your password instead
  </Link>
);

interface Problem {
  state: EmailCodeErrorState;
  minutes?: number;
}

function ProblemText({ problem }: { problem: Problem }) {
  if (problem.state === "unavailable") {
    return (
      <>
        Email codes are unavailable right now.{" "}
        <Link href="/login" className={linkClass}>
          Sign in with your password
        </Link>
        , or{" "}
        <Link href="/forgot-password" className={linkClass}>
          reset it
        </Link>
        .
      </>
    );
  }
  return <>{emailCodeMessage(problem.state, problem.minutes)}</>;
}

// Links the field to the server's answer (and to its own validation message),
// which FormControl alone would not.
function CodeInput({
  field,
  problem,
}: {
  field: ControllerRenderProps<CodeFieldValues, "otp">;
  problem: boolean;
}) {
  const { error, formMessageId } = useFormField();
  const describedBy = [problem && "code-problem", error && formMessageId]
    .filter(Boolean)
    .join(" ");
  return (
    <FormControl>
      <Input
        {...field}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={EMAIL_CODE_LENGTH}
        pattern="\d{6}"
        aria-describedby={describedBy || undefined}
      />
    </FormControl>
  );
}

function toProblem(result: EmailCodeFailure): Problem {
  return { state: result.state, minutes: result.retryAfterMinutes };
}

// Two steps of client state. Step 2 is the same for every address that was
// accepted, so nothing here reveals whether an account exists or may use a code.
export function CodeForm() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);

  const emailForm = useForm<EmailCodeRequestValues>({
    resolver: zodResolver(emailCodeRequestSchema),
    defaultValues: { email: "" },
  });
  const codeForm = useForm<CodeFieldValues>({
    resolver: zodResolver(codeFieldSchema),
    defaultValues: { otp: "" },
  });
  const { setFocus: focusEmail } = emailForm;
  const { setFocus: focusCode } = codeForm;

  useEffect(() => {
    if (step === "email") focusEmail("email");
    else focusCode("otp");
  }, [step, focusEmail, focusCode]);

  // The countdown is visible text only: it is not a live region, so a screen
  // reader does not announce it every second.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function send(address: string): Promise<boolean> {
    setProblem(null);
    let result;
    try {
      result = await requestCode({ email: address });
    } catch {
      setProblem({ state: "unexpected" });
      return false;
    }
    if (!result.ok) {
      setProblem(toProblem(result));
      return false;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
    return true;
  }

  async function submitEmail(values: EmailCodeRequestValues) {
    if (!(await send(values.email))) return;
    setEmail(values.email);
    codeForm.reset();
    setStep("code");
  }

  async function resend() {
    setResending(true);
    try {
      if (await send(email)) codeForm.reset();
    } finally {
      setResending(false);
    }
  }

  async function submitCode(values: CodeFieldValues) {
    setProblem(null);
    let result: EmailCodeFailure;
    try {
      // Redirects on success; the form stays pending until the browser leaves.
      result = await verifyCode({ email, otp: values.otp });
    } catch {
      setProblem({ state: "unexpected" });
      return;
    }
    setProblem(toProblem(result));
    codeForm.reset();
    focusCode("otp");
  }

  function changeEmail() {
    setProblem(null);
    setCooldown(0);
    emailForm.reset({ email });
    setStep("email");
  }

  if (step === "email") {
    return (
      <AuthShell
        title="Sign in with an email code"
        description="Enter your SGA account email and we'll send you a 6-digit code."
        footer={passwordInstead}
        requiresJs
      >
        <Form {...emailForm}>
          <form
            onSubmit={emailForm.handleSubmit(submitEmail)}
            noValidate
            className="flex flex-col gap-4"
          >
            <FormField
              control={emailForm.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      autoComplete="email"
                      maxLength={320}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {problem ? (
              <p role="alert" className="text-sm text-destructive">
                <ProblemText problem={problem} />
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full"
              disabled={emailForm.formState.isSubmitting}
            >
              {emailForm.formState.isSubmitting ? "Sending…" : "Send code"}
            </Button>
          </form>
        </Form>
      </AuthShell>
    );
  }

  const pending = codeForm.formState.isSubmitting;

  return (
    <AuthShell
      title="Check your email"
      description={
        <>
          If an account can use email codes, we sent a 6-digit code to{" "}
          <strong className="break-all">{email}</strong>. It expires in 10
          minutes.
        </>
      }
      footer={passwordInstead}
      requiresJs
    >
      <Form {...codeForm}>
        <form
          onSubmit={codeForm.handleSubmit(submitCode)}
          noValidate
          className="flex flex-col gap-4"
        >
          <FormField
            control={codeForm.control}
            name="otp"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Code</FormLabel>
                <CodeInput field={field} problem={problem !== null} />
                {problem ? (
                  <p
                    id="code-problem"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    <ProblemText problem={problem} />
                  </p>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Form>
      <div className="flex items-center justify-between gap-2 text-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={cooldown > 0 || resending}
          onClick={resend}
        >
          {cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={changeEmail}>
          Use a different email
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Admins and accounts with two-factor authentication must sign in with a
        password.
      </p>
    </AuthShell>
  );
}
