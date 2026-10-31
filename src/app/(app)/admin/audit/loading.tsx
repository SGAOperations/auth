import { Skeleton } from "@/components/ui/skeleton";

export default function AuditLogLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-muted-foreground">
          Every security-relevant action in SGAuth. Times are Eastern.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
        <span role="status" className="sr-only">
          Loading…
        </span>
      </div>
    </div>
  );
}
