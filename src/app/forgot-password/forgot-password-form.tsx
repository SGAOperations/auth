"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import {
  AUTH_COPY,
  forgotPasswordSchema,
  mapRequestError,
  type ForgotPasswordValues,
} from "@/lib/auth/forms";

const linkClass = "underline underline-offset-4 hover:text-foreground";

const backToSignIn = (
  <Link href="/login" className={linkClass}>
    Back to sign in
  </Link>
);

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit({ email }: ForgotPasswordValues) {
    setFormError(null);
    try {
      // No redirectTo: the reset link is built server-side.
      const { error } = await authClient.requestPasswordReset({ email });
      if (error) {
        setFormError(
          mapRequestError(error) === "rate-limited"
            ? AUTH_COPY.forgotRateLimited
            : AUTH_COPY.unexpected,
        );
        return;
      }
    } catch {
      setFormError(AUTH_COPY.unexpected);
      return;
    }
    // The same answer for every address.
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            If an account uses <strong className="break-all">{sentTo}</strong>,
            we&apos;ve sent a password reset link. It works once and expires in
            1 hour.
          </>
        }
        footer={backToSignIn}
        requiresJs
      />
    );
  }

  const pending = form.formState.isSubmitting;

  return (
    <AuthShell
      title="Reset your password"
      description="Enter your account email and we'll send you a reset link."
      footer={backToSignIn}
      requiresJs
    >
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <FormField
            control={form.control}
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
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
