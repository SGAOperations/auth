"use client";

import { useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import { DisabledReason } from "@/components/admin/disabled-reason";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAdminAction } from "@/hooks/use-admin-action";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { assignPositions, unassignPosition } from "../actions";

export interface PositionOption {
  id: string;
  key: string;
  name: string;
  category: string | null;
}

const UNCATEGORIZED = "Uncategorized";

function groupByCategory(options: readonly PositionOption[]) {
  const groups = new Map<string, PositionOption[]>();
  for (const option of options) {
    const category = option.category ?? UNCATEGORIZED;
    groups.set(category, [...(groups.get(category) ?? []), option]);
  }
  return [...groups.entries()];
}

export function PositionsEditor({
  userId,
  held,
  options,
  assignReason,
  unassignReason,
}: {
  userId: string;
  held: readonly PositionOption[];
  /** Every position that is not deleted. Held ones are filtered out here. */
  options: readonly PositionOption[];
  assignReason: string | null;
  unassignReason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const atCap = held.length >= MAX_ACTIVE_POSITIONS_PER_USER;
  const addReason =
    assignReason ??
    (atCap
      ? `Users can hold at most ${MAX_ACTIVE_POSITIONS_PER_USER} positions.`
      : null);

  const groups = useMemo(() => {
    const heldIds = new Set(held.map((position) => position.id));
    const needle = filter.trim().toLowerCase();
    return groupByCategory(
      options.filter(
        (option) =>
          !heldIds.has(option.id) &&
          (needle === "" ||
            option.name.toLowerCase().includes(needle) ||
            option.key.includes(needle)),
      ),
    );
  }, [held, options, filter]);

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function assign() {
    const ids = [...selected];
    await run(() => assignPositions(userId, ids), {
      success: `Assigned ${ids.length} ${ids.length === 1 ? "position" : "positions"}.`,
      onSuccess: () => setSelected(new Set()),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Positions</CardTitle>
        <CardDescription>
          {held.length} of {MAX_ACTIVE_POSITIONS_PER_USER}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {held.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No positions. This user can sign in but has no product access.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="Current positions">
            {held.map((position) => (
              <li key={position.id}>
                <Badge variant="secondary" className="h-6 gap-1 pr-1">
                  {position.name}
                  <button
                    type="button"
                    aria-label={`Remove ${position.name}`}
                    title={unassignReason ?? `Remove ${position.name}`}
                    disabled={unassignReason !== null || pending}
                    onClick={() =>
                      run(() => unassignPosition(userId, position.id), {
                        success: `Removed ${position.name}.`,
                      })
                    }
                    className="inline-flex size-4 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {unassignReason ? (
          <p className="text-xs text-muted-foreground">{unassignReason}</p>
        ) : null}

        <fieldset
          className="flex max-w-md flex-col gap-3"
          disabled={addReason !== null}
        >
          <legend className="text-sm font-medium">Add positions</legend>
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search by name or key"
            aria-label="Search positions"
            autoComplete="off"
          />
          <div className="max-h-56 overflow-y-auto rounded-lg border p-2">
            {groups.length === 0 ? (
              <p className="p-1 text-sm text-muted-foreground">
                {filter.trim() === ""
                  ? "Every position is already assigned."
                  : "No positions match."}
              </p>
            ) : (
              groups.map(([category, entries]) => (
                <div key={category} className="flex flex-col gap-1 py-1">
                  <p className="px-1 text-xs font-medium text-muted-foreground">
                    {category}
                  </p>
                  {entries.map((entry) => (
                    <label
                      key={entry.id}
                      className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        checked={selected.has(entry.id)}
                        onCheckedChange={(checked) =>
                          toggle(entry.id, checked === true)
                        }
                      />
                      <span>{entry.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.key}
                      </span>
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
        </fieldset>
        <DisabledReason
          reason={addReason}
          busy={pending || selected.size === 0}
        >
          {(controlProps) => (
            <Button type="button" onClick={assign} {...controlProps}>
              {selected.size > 0 ? `Assign ${selected.size}` : "Assign"}
            </Button>
          )}
        </DisabledReason>
      </CardContent>
    </Card>
  );
}
