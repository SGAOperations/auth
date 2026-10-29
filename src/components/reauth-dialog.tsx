"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import {
  REAUTH_ERROR_CODES,
  reauthBodySchema,
  type ReauthBody,
} from "@/lib/auth/reauth-policy";

// The sudo-mode prompt (docs/REAUTH.md). `ReauthProvider` holds one dialog;
// `useReauth().fetch` opens it on a 403 REAUTH_REQUIRED and retries the request
// once the session is fresh.

const REAUTH_PATH = "/api/sgauth/reauth";

// The 400 and 403 copy lives with the codes in reauth-policy.ts.
const ERROR_COPY = {
  rateLimited: "Too many attempts. Wait a minute and try again.",
  signedOut: "Your session has ended. Sign in again.",
  generic: "Something went wrong. Try again.",
} as const;

interface ReauthContextValue {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Opens the prompt. Resolves true once the session is fresh, false on cancel. */
  prompt: () => Promise<boolean>;
}

const ReauthContext = createContext<ReauthContextValue | null>(null);

/**
 * A `fetch` that prompts for credentials when the server asks for them, and the
 * bare `prompt` for a caller that learns of the need some other way, such as a
 * Server Action's result.
 */
export function useReauth(): ReauthContextValue {
  const value = useContext(ReauthContext);
  if (!value) throw new Error("useReauth must be used inside <ReauthProvider>");
  return value;
}

interface ReauthProviderProps {
  children: ReactNode;
  /** Shows the code field from the start. */
  twoFactorEnabled?: boolean;
}

export function ReauthProvider({
  children,
  twoFactorEnabled = false,
}: ReauthProviderProps) {
  const [open, setOpen] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
  }, []);

  const prompt = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        // A second prompt while one is open cancels the first.
        pending.current?.(false);
        pending.current = resolve;
        setOpen(true);
      }),
    [],
  );

  const value = useMemo<ReauthContextValue>(
    () => ({
      fetch: (input, init) =>
        fetchWithReauth(input, init, { onReauthRequired: prompt }),
      prompt,
    }),
    [prompt],
  );

  return (
    <ReauthContext value={value}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) settle(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <ReauthForm
            twoFactorEnabled={twoFactorEnabled}
            onCancel={() => settle(false)}
            onSuccess={() => settle(true)}
          />
        </DialogContent>
      </Dialog>
    </ReauthContext>
  );
}

interface ReauthFormProps {
  twoFactorEnabled: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}

function ReauthForm({
  twoFactorEnabled,
  onCancel,
  onSuccess,
}: ReauthFormProps) {
  const [showCode, setShowCode] = useState(twoFactorEnabled);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const form = useForm<ReauthBody>({
    resolver: zodResolver(reauthBodySchema),
    defaultValues: { password: "" },
  });
  const submitting = form.formState.isSubmitting;

  function fail(message: string) {
    setError(message);
    form.resetField("password", { defaultValue: "" });
    form.resetField("code", { defaultValue: undefined });
  }

  // The inputs are disabled while submitting, so focus returns only once the
  // submit has settled with an error.
  useEffect(() => {
    if (error && !submitting) form.setFocus("password");
  }, [error, submitting, form]);

  async function onSubmit(values: ReauthBody) {
    setError(null);
    setSignedOut(false);
    let response: Response;
    try {
      response = await fetch(REAUTH_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
    } catch {
      fail(ERROR_COPY.generic);
      return;
    }
    if (response.ok) {
      onSuccess();
      return;
    }

    const code = await errorCode(response);
    if (response.status === 401) {
      setSignedOut(true);
      fail(ERROR_COPY.signedOut);
    } else if (response.status === 429) {
      fail(ERROR_COPY.rateLimited);
    } else if (code === REAUTH_ERROR_CODES.TWO_FACTOR_CODE_REQUIRED.code) {
      setShowCode(true);
      fail(REAUTH_ERROR_CODES.TWO_FACTOR_CODE_REQUIRED.message);
    } else if (code === REAUTH_ERROR_CODES.REAUTH_LOCKED.code) {
      fail(REAUTH_ERROR_CODES.REAUTH_LOCKED.message);
    } else if (code === REAUTH_ERROR_CODES.INVALID_REAUTH_CREDENTIALS.code) {
      fail(REAUTH_ERROR_CODES.INVALID_REAUTH_CREDENTIALS.message);
    } else {
      fail(ERROR_COPY.generic);
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        <DialogHeader>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            {showCode
              ? "For your security, enter your password and a code from your authenticator app to continue."
              : "For your security, enter your password to continue."}
          </DialogDescription>
        </DialogHeader>

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  disabled={submitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {showCode ? (
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Authentication code</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    onChange={(event) =>
                      field.onChange(event.target.value || undefined)
                    }
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    disabled={submitting}
                  />
                </FormControl>
                <FormDescription>
                  Lost your device? Enter a backup code instead.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {signedOut ? (
              <>
                {" "}
                <Link href="/" className="underline underline-offset-3">
                  Sign in
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Confirming…" : "Confirm"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "code" in body) {
      return typeof body.code === "string" ? body.code : null;
    }
  } catch {
    // A body that is not JSON carries no code.
  }
  return null;
}
