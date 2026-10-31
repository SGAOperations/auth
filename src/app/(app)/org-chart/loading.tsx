import { Skeleton } from "@/components/ui/skeleton";

export default function OrgChartLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      aria-busy="true"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Org chart</h1>
        <p className="text-muted-foreground">
          How SGA positions report to each other.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
        <span role="status" className="sr-only">
          Loading…
        </span>
      </div>
    </div>
  );
}
