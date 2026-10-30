"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  hasActiveFilters,
  serializeUsersListParams,
  type UsersListParams,
} from "@/lib/admin/users-list-params";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;

const selectClass = cn(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
);

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function UsersFilters({
  params,
  positions,
}: {
  params: UsersListParams;
  positions: ReadonlyArray<{ key: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(params.q ?? "");

  const navigate = useCallback(
    (next: Partial<UsersListParams>) => {
      // A filter change always returns to the first page.
      const query = serializeUsersListParams({
        ...params,
        ...next,
        page: 1,
      }).toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [params, pathname, router],
  );

  // Search waits for a pause in typing. The trimmed value is compared with the
  // URL's, so nothing happens on mount or once the URL has caught up.
  useEffect(() => {
    const value = search.trim();
    if (value === (params.q ?? "")) return;
    const timer = setTimeout(
      () => navigate({ q: value === "" ? undefined : value }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search, params.q, navigate]);

  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <FilterField label="Search">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or email"
            maxLength={100}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Status">
          <select
            className={selectClass}
            value={params.status}
            onChange={(event) =>
              navigate({
                status: event.target.value as UsersListParams["status"],
              })
            }
          >
            <option value="default">Active &amp; deactivated</option>
            <option value="active">Active</option>
            <option value="deactivated">Deactivated</option>
            <option value="deleted">Deleted</option>
          </select>
        </FilterField>
        <FilterField label="Admin">
          <select
            className={selectClass}
            value={params.admin}
            onChange={(event) =>
              navigate({
                admin: event.target.value as UsersListParams["admin"],
              })
            }
          >
            <option value="any">Anyone</option>
            <option value="yes">Admins</option>
            <option value="no">Non-admins</option>
          </select>
        </FilterField>
        <FilterField label="Position">
          <select
            className={selectClass}
            value={params.position ?? ""}
            onChange={(event) =>
              navigate({ position: event.target.value || undefined })
            }
          >
            <option value="">Any position</option>
            {positions.map((position) => (
              <option key={position.key} value={position.key}>
                {position.name}
              </option>
            ))}
          </select>
        </FilterField>
      </form>
      {hasActiveFilters(params) || search !== "" ? (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => {
            setSearch("");
            router.replace(pathname);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
