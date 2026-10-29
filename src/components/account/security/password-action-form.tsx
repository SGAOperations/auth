"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { PasswordField } from "@/components/auth/password-field";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  passwordOnlySchema,
  SECURITY_SIGN_IN_PATH,
  type PasswordOnlyValues,
  type SecurityError,
} from "@/lib/account/security-ui";

interface PasswordActionFormProps {
  submitLabel: string;
  pendingLabel: string;
  variant?: "default" | "destructive";
  /** Text above the button, such as a warning. */
  notice?: ReactNode;
  autoFocus?: boolean;
  /** Resolves to the error to show, or null when there is nothing to show. */
  onSubmit: (password: string) => Promise<SecurityError | null>;
}

/**
 * A card section that asks for the password and runs one action. The wrong
 * password shows under the field; every other failure shows as an alert.
 */
export function PasswordActionForm({
  submitLabel,
  pendingLabel,
  variant = "default",
  notice,
  autoFocus = false,
  onSubmit,
}: PasswordActionFormProps) {
  const router = useRouter();
  const [formError, setFormError] = useState<SecurityError | null>(null);
  const [failures, setFailures] = useState(0);
  const form = useForm<PasswordOnlyValues>({
    resolver: zodResolver(passwordOnlySchema),
    defaultValues: { password: "" },
  });
  const submitting = form.formState.isSubmitting;
  const { setFocus } = form;

  // The input is disabled while submitting, so focus returns once it settles.
  useEffect(() => {
    if (failures > 0 && !submitting) setFocus("password");
  }, [failures, submitting, setFocus]);

  async function submit(values: PasswordOnlyValues) {
    setFormError(null);
    const error = await onSubmit(values.password);
    if (!error) return;
    form.resetField("password", { defaultValue: "" });
    if (error.field === "password") {
      form.setError("password", { message: error.message });
    } else {
      setFormError(error);
    }
    setFailures((count) => count + 1);
    if (error.refresh) router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(submit)}
        noValidate
        className="flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Your password</FormLabel>
              <FormControl>
                <PasswordField
                  {...field}
                  autoComplete="current-password"
                  autoFocus={autoFocus}
                  disabled={submitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {notice ? (
          <p className="text-sm text-muted-foreground">{notice}</p>
        ) : null}
        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError.message}
            {formError.signedOut ? (
              <>
                {" "}
                <Link
                  href={SECURITY_SIGN_IN_PATH}
                  className="underline underline-offset-4"
                >
                  Sign in
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        <Button
          type="submit"
          variant={variant}
          className="w-full sm:w-auto sm:self-start"
          disabled={submitting}
        >
          {submitting ? pendingLabel : submitLabel}
        </Button>
      </form>
    </Form>
  );
}
