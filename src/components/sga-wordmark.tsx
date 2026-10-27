import { cn } from "@/lib/utils";

export function SgaWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-base tracking-tight", className)}>
      <span className="font-semibold text-brand">SGA</span>{" "}
      <span className="text-muted-foreground">Account</span>
    </span>
  );
}
