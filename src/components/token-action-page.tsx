import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Shared page of every emailed token link. `ready` is a form that POSTs to the
// confirm route, the only way the token is consumed. The form works without
// JavaScript; the password fields only add show/hide and a length count.

type Outcome = "done" | "invalid" | "used" | "rate" | "sent" | "error";

interface Message {
  title: string;
  body: ReactNode;
  cta?: { label: string; href: string };
}

const DEFAULT_MESSAGES = {
  invalid: {
    title: "This link isn't valid",
    body: "It may have expired. Request a new one and use the latest email.",
  },
  used: {
    title: "This link has already been used",
    body: "Each link works once. If you just used it, you're all set. Otherwise, request a new one.",
    cta: { label: "Continue to sign in", href: "/" },
  },
  rate: {
    title: "Too many attempts",
    body: "Wait a few minutes, then open the link from your email again.",
  },
  sent: {
    title: "Check your inbox",
    body: "If a new link is needed, we've sent one to your email.",
  },
  error: {
    title: "Something went wrong",
    body: "We couldn't finish that. Open the link from your email again in a moment.",
  },
} satisfies Record<Exclude<Outcome, "done">, Message>;

export interface TokenActionPageProps {
  title: string;
  description: ReactNode;
  state: "ready" | Outcome;
  /** Required in the `ready` state: the form posts it back. */
  token?: string;
  /** The page's POST route, such as `/verify-email/confirm`. */
  confirmPath: string;
  actionLabel: string;
  /** Extra form fields, rendered inside the form. */
  children?: ReactNode;
  error?: ReactNode;
  messages: {
    done: Message;
    invalid?: Message;
    used?: Message;
    rate?: Message;
    sent?: Message;
  };
}

/** Each page exports this as its `metadata`: a token page is never indexed. */
export function tokenActionMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: false } };
}

export function TokenActionPage({
  title,
  description,
  state,
  token,
  confirmPath,
  actionLabel,
  children,
  error,
  messages,
}: TokenActionPageProps) {
  if (state !== "ready") {
    const override = state === "error" ? undefined : messages[state];
    const message: Message =
      state === "done" ? messages.done : (override ?? DEFAULT_MESSAGES[state]);
    return (
      <AuthShell title={message.title} description={message.body}>
        {message.cta ? (
          <a href={message.cta.href} className={cn(buttonVariants(), "w-full")}>
            {message.cta.label}
          </a>
        ) : null}
      </AuthShell>
    );
  }

  return (
    <AuthShell title={title} description={description}>
      <form method="post" action={confirmPath} className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token ?? ""} />
        {children}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full">
          {actionLabel}
        </Button>
      </form>
    </AuthShell>
  );
}
