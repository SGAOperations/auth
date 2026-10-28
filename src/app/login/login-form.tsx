"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { ResendVerification } from "@/components/auth/resend-verification";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient, postEmailStep } from "@/lib/auth/client";
import {
  AUTH_COPY,
  emailStepSchema,
  mapSignInError,
  signInMessage,
  signInSchema,
  type EmailStepValues,
  type SignInState,
  type SignInValues,
} from "@/lib/auth/forms";
import { completeSignIn } from "./actions";

const linkClass = "underline underline-offset-4 hover:text-foreground";

// Two steps of client state; the URL and its `redirect` param never change.
// Step 2 is the same for every address, so nothing here reveals whether an
// account exists or has a password.
export function LoginForm() {
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [hint, setHint] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [signInState, setSignInState] = useState<SignInState | null>(null);

  const emailForm = useForm<EmailStepValues>({
    resolver: zodResolver(emailStepSchema),
    defaultValues: { email: "" },
  });
  const passwordForm = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { password: "" },
  });
  const { setFocus: focusEmail } = emailForm;
  const { setFocus: focusPassword } = passwordForm;

  useEffect(() => {
    if (step === "email") focusEmail("email");
    else focusPassword("password");
  }, [step, focusEmail, focusPassword]);

  async function submitEmail(values: EmailStepValues) {
    setEmailError(null);
    const outcome = await postEmailStep(values.email);
    if (outcome.kind === "field-error") {
      emailForm.setError("email", { message: outcome.message });
      return;
    }
    if (outcome.kind === "rate-limited") {
      setEmailError(AUTH_COPY.emailStepRateLimited);
      return;
    }
    setEmail(values.email);
    setHint(outcome.hint);
    setSignInState(null);
    passwordForm.reset();
    setStep("password");
  }

  async function submitPassword(values: SignInValues) {
    setSignInState(null);
    let failure: SignInState | null = null;
    try {
      const { data, error } = await authClient.signIn.email({
        email,
        password: values.password,
      });
      if (error) failure = mapSignInError(error);
      else if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        failure = "two-factor";
      }
    } catch {
      failure = "unexpected";
    }

    if (failure) {
      setSignInState(failure);
      passwordForm.resetField("password");
      focusPassword("password");
      return;
    }
    // Redirects; the form stays pending until the browser leaves.
    await completeSignIn();
  }

  function changeEmail() {
    setSignInState(null);
    setEmailError(null);
    emailForm.reset({ email });
    setStep("email");
  }

  const newHere = (
    <>
      New here?{" "}
      <Link href="/sign-up" className={linkClass}>
        Create an account
      </Link>
    </>
  );

  if (step === "email") {
    return (
      <AuthShell
        title="Sign in"
        description="Enter your email to continue."
        footer={newHere}
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
                      autoComplete="username"
                      maxLength={320}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {emailError ? (
              <p role="alert" className="text-sm text-destructive">
                {emailError}
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full"
              disabled={emailForm.formState.isSubmitting}
            >
              {emailForm.formState.isSubmitting ? "Continuing…" : "Continue"}
            </Button>
          </form>
        </Form>
      </AuthShell>
    );
  }

  const pending = passwordForm.formState.isSubmitting;

  return (
    <AuthShell
      title="Sign in"
      description="Enter your password."
      footer={newHere}
      requiresJs
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 font-medium break-all">{email}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Change email"
          onClick={changeEmail}
        >
          Change
        </Button>
      </div>
      <Form {...passwordForm}>
        <form
          onSubmit={passwordForm.handleSubmit(submitPassword)}
          noValidate
          className="flex flex-col gap-4"
        >
          {/* Pairs the saved credential with the address typed in step 1. */}
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
          />
          <FormField
            control={passwordForm.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-2">
                  <FormLabel>Password</FormLabel>
                  <Link
                    href="/forgot-password"
                    className={`${linkClass} text-sm text-muted-foreground`}
                  >
                    Forgot password?
                  </Link>
                </div>
                <FormControl>
                  <PasswordField {...field} autoComplete="current-password" />
                </FormControl>
                {hint ? (
                  <FormDescription>{AUTH_COPY.firstSignInHint}</FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          {signInState ? (
            <p role="alert" className="text-sm text-destructive">
              {signInMessage(signInState)}
            </p>
          ) : null}
          {signInState === "unverified" ? (
            <ResendVerification email={email} />
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
