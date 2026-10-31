"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { PasswordField } from "@/components/auth/password-field";
import { useReauth } from "@/components/reauth-dialog";
import { Button } from "@/components/ui/button";
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
import {
  postSecurity,
  SECURITY_SIGN_IN_PATH,
  type SecurityError,
} from "@/lib/account/security-ui";
import {
  changePasswordFormSchema,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/policy";

type ChangePasswordValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

const EMPTY: ChangePasswordValues = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function ChangePasswordForm() {
  const reauth = useReauth();
  const [formError, setFormError] = useState<SecurityError | null>(null);
  const [changed, setChanged] = useState(false);
  const [failures, setFailures] = useState(0);
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: EMPTY,
  });
  const submitting = form.formState.isSubmitting;
  const { setFocus, formState } = form;
  const newLength = useWatch({
    control: form.control,
    name: "newPassword",
  }).length;

  // The inputs are disabled while submitting, so focus moves once it settles:
  // to the first field that has an error.
  useEffect(() => {
    if (failures === 0 || submitting) return;
    const first = (
      ["currentPassword", "newPassword", "confirmPassword"] as const
    ).find((name) => formState.errors[name]);
    if (first) setFocus(first);
  }, [failures, submitting, formState.errors, setFocus]);

  async function submit(values: ChangePasswordValues) {
    setFormError(null);
    setChanged(false);
    const result = await postSecurity(
      reauth.fetch,
      "/api/auth/change-password",
      {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      },
    );
    if (result.ok) {
      form.reset(EMPTY);
      setChanged(true);
      return;
    }
    // A cancelled re-auth dialog says nothing: the form stays as it was.
    const error = result.error;
    if (!error) return;
    if (error.field === "password") {
      form.resetField("currentPassword", { defaultValue: "" });
      form.setError("currentPassword", { message: error.message });
    } else if (error.field === "newPassword") {
      form.setError("newPassword", { message: error.message });
    } else {
      setFormError(error);
    }
    setFailures((count) => count + 1);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing your password signs you out on your other devices.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(submit)}
            noValidate
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current password</FormLabel>
                  <FormControl>
                    <PasswordField
                      {...field}
                      autoComplete="current-password"
                      disabled={submitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <PasswordField
                      {...field}
                      autoComplete="new-password"
                      disabled={submitting}
                    />
                  </FormControl>
                  {newLength > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {newLength < PASSWORD_MIN_LENGTH
                        ? `At least ${PASSWORD_MIN_LENGTH} characters`
                        : "Looks good"}
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm new password</FormLabel>
                  <FormControl>
                    <PasswordField
                      {...field}
                      autoComplete="new-password"
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
            {changed ? (
              <p role="status" className="text-sm">
                Password changed. You&apos;ve been signed out on your other
                devices.
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full sm:w-auto sm:self-start"
              disabled={submitting}
            >
              {submitting ? "Changing…" : "Change password"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
