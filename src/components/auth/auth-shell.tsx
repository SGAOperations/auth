import type { ReactNode } from "react";
import { SgaWordmark } from "@/components/sga-wordmark";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { AUTH_COPY } from "@/lib/auth/forms";

interface AuthShellProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Pages whose forms need JavaScript show a notice when it is off. */
  requiresJs?: boolean;
}

// The one card every public auth page sits in.
export function AuthShell({
  title,
  description,
  children,
  footer,
  requiresJs = false,
}: AuthShellProps) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <SgaWordmark className="mb-2" />
          {/* CardTitle renders a div; the page needs a real h1. */}
          <h1 className="font-heading text-base leading-snug font-medium">
            {title}
          </h1>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
        {requiresJs ? (
          <noscript>
            <p role="alert" className="px-4 text-sm text-destructive">
              {AUTH_COPY.noScript}
            </p>
          </noscript>
        ) : null}
        {children ? (
          <CardContent className="flex flex-col gap-4">{children}</CardContent>
        ) : null}
        {footer ? (
          <div className="px-4 text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </Card>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {AUTH_COPY.brandLine}
      </p>
    </main>
  );
}
