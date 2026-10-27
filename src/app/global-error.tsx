"use client";

// Replaces the root layout when it fails, so it renders its own dark shell with
// plain Tailwind: no providers, no env.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground">
        <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center gap-4 px-4 py-12">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-muted-foreground">
            We couldn&apos;t load this page. Try again, or go back to your
            account.
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Reference: {error.digest}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
            <a
              href="/account"
              className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium"
            >
              Go to your account
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
