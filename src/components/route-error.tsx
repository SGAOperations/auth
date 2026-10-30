"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";

// The shared body of every segment error.tsx. It never renders error.message,
// which can carry server detail; the digest is the only reference shown.
export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <Empty className="border">
      <EmptyHeader>
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-heading text-base font-medium tracking-tight outline-none"
        >
          Something went wrong
        </h1>
        <EmptyDescription>
          We couldn&apos;t load this page. Try again, and if it keeps happening,
          contact SGA Operations with the reference below.
        </EmptyDescription>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" render={<Link href="/" />}>
          Go to home
        </Button>
      </EmptyContent>
    </Empty>
  );
}
