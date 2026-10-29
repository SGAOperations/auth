import Link from "next/link";
import { cn } from "@/lib/utils";

export function PositionsTabs({
  current,
  activeCount,
  deletedCount,
}: {
  current: "active" | "deleted";
  activeCount: number;
  deletedCount: number;
}) {
  const tabs = [
    {
      id: "active",
      href: "/admin/positions",
      label: `Active (${activeCount})`,
    },
    {
      id: "deleted",
      href: "/admin/positions/deleted",
      label: `Deleted (${deletedCount})`,
    },
  ] as const;

  return (
    <nav aria-label="Position lists" className="flex gap-1 border-b">
      {tabs.map((tab) => {
        const isCurrent = tab.id === current;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={isCurrent ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground",
              isCurrent && "border-foreground text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
