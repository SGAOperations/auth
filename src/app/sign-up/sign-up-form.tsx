"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { ResendVerification } from "@/components/auth/resend-verification";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { authClient } from "@/lib/auth/client";
import {
  AUTH_COPY,
  mapSignUpError,
  signUpSchema,
  type SignUpValues,
} from "@/lib/auth/forms";
import { cn } from "@/lib/utils";

const linkClass = "underline underline-offset-4 hover:text-foreground";

export function SignUpForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    mode: "onTouched",
    defaultValues: { name: "", email: "", password: "" },
  });

  async function onSubmit(values: SignUpValues) {
    setFormError(null);
    let message: string | null = null;
    try {
      const { error } = await authClient.signUp.email(values);
      if (error) {
        const mapped = mapSignUpError(error);
        if (mapped.field) {
          form.setError(mapped.field, { message: mapped.message });
          form.setFocus(mapped.field);
          return;
        }
        message = mapped.message;
      }
    } catch {
      message = AUTH_COPY.unexpected;
    }
    if (message) {
      setFormError(message);
      return;
    }
    // The same screen for a new address and an existing one.
    setSentTo(values.email);
  }

  if (sentTo) {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            If <strong className="break-all">{sentTo}</strong> needs verifying,
            or doesn&apos;t have a password yet, we&apos;ve emailed you a link.
            Already signed up?{" "}
            <Link href="/login" className={linkClass}>
              Sign in
            </Link>{" "}
            instead.
          </>
        }
        requiresJs
      >
        <ResendVerification email={sentTo} />
        <Link
          href="/login"
          className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
        >
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const pending = form.formState.isSubmitting;

  return (
    <AuthShell
      title="Create your SGA account"
      description="Students sign up with their northeastern.edu email."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className={linkClass}>
            Sign in
          </Link>
        </>
      }
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
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input {...field} autoComplete="name" maxLength={100} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
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
                <FormDescription>
                  Use your @northeastern.edu address.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <PasswordField
                    {...field}
                    showLengthFeedback
                    autoComplete="new-password"
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
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
