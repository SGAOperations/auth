import { Skeleton } from "@/components/ui/skeleton";

export default function UsersLoading() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading users"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
