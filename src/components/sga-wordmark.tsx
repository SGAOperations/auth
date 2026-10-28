import Image from "next/image";
import { cn } from "@/lib/utils";

export function SgaWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-base tracking-tight",
        className,
      )}
    >
      {/* Decorative: the text beside it names the product. */}
      <Image src="/sgauth-logo.svg" alt="" width={28} height={28} priority />
      <span>
        <span className="font-semibold text-brand">SGA</span>{" "}
        <span className="text-muted-foreground">Account</span>
      </span>
    </span>
  );
}
