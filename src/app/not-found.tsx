import Link from "next/link";
import { SgaWordmark } from "@/components/sga-wordmark";
import { Button } from "@/components/ui/button";

// One page for unknown URLs and for the admin denial, so they cannot be told apart.
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-start justify-center gap-4 px-4 py-12">
      <SgaWordmark />
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist or you don&apos;t
        have access to it.
      </p>
      <Button render={<Link href="/" />}>Go to home</Button>
    </main>
  );
}
