"use client";

import { LightRays } from "@/components/backdrop/light-rays";
import { buttonVariants } from "@/components/ui/button";

// Replaces the root layout when it fails, so it renders its own dark shell
// with no providers and no env. LightRays is pure markup and buttonVariants is
// a pure cva, so both are safe here; the dust canvas is left out.
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
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden forced-colors:hidden print:hidden"
        >
          <LightRays />
        </div>
        <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-start justify-center gap-4 px-4 py-12">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-muted-foreground">
            We couldn&apos;t load this page. Try again, or go back to the home
            page.
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Reference: {error.digest}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={reset} className={buttonVariants()}>
              Try again
            </button>
            {/* A full page load on purpose: the router and root layout failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={buttonVariants({ variant: "outline" })}>
              Go to home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
