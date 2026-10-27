import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t px-4 py-4 text-center text-sm text-muted-foreground">
      Northeastern SGA ·{" "}
      <Link href="/privacy" className="underline-offset-4 hover:underline">
        Privacy
      </Link>
    </footer>
  );
}
