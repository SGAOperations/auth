import Link from "next/link";
import { MotionToggle } from "@/components/backdrop/motion-toggle";

export function SiteFooter() {
  return (
    <footer className="mt-auto flex flex-wrap items-center justify-center gap-x-2 border-t px-4 py-2 text-center text-sm text-muted-foreground">
      <span>Northeastern SGA ·</span>
      <Link
        href="/privacy"
        className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
      >
        Privacy
      </Link>
      <span aria-hidden="true">·</span>
      <MotionToggle />
    </footer>
  );
}
