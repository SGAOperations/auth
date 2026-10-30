"use client";

import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { descendantsOf } from "@/lib/position-org";
import { groupPositionsByCategory } from "@/lib/position-view";

export interface ManagerOption {
  id: string;
  name: string;
  category: string | null;
  managerPositionId: string | null;
}

const NO_MANAGER = "";

/**
 * The Leadership switch and the "Reports to" picker, as the create dialog and
 * the edit form both show them. `managerError` is the server's message for a
 * manager that is gone or would make a loop.
 */
export function OrgFields({
  idPrefix,
  isLeadership,
  onLeadershipChange,
  managerPositionId,
  onManagerChange,
  options,
  selfId,
  managerError,
}: {
  idPrefix: string;
  isLeadership: boolean;
  onLeadershipChange: (next: boolean) => void;
  managerPositionId: string | null;
  onManagerChange: (next: string | null) => void;
  options: readonly ManagerOption[];
  selfId?: string;
  managerError: string | null;
}) {
  const leadershipId = `${idPrefix}-leadership`;
  const managerLabelId = `${idPrefix}-manager-label`;
  const managerHintId = `${idPrefix}-manager-hint`;
  const managerErrorId = `${idPrefix}-manager-error`;

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Switch
            id={leadershipId}
            checked={isLeadership}
            onCheckedChange={onLeadershipChange}
          />
          <Label htmlFor={leadershipId}>Leadership position</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Leadership positions can see leadership-only products and resources.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label id={managerLabelId}>Reports to</Label>
        <ManagerPicker
          value={managerPositionId}
          onChange={onManagerChange}
          options={options}
          selfId={selfId}
          labelId={managerLabelId}
          describedBy={managerError ? managerErrorId : managerHintId}
          error={managerError}
        />
        <p id={managerHintId} className="text-xs text-muted-foreground">
          Used for the org chart. A position can&apos;t report to itself or to a
          position below it.
        </p>
        {managerError ? (
          <p
            id={managerErrorId}
            role="alert"
            className="text-sm text-destructive"
          >
            {managerError}
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * The "Reports to" dropdown. The position being edited (`selfId`) and everything
 * below it are disabled, so the picker cannot offer a loop. The server checks
 * again.
 */
export function ManagerPicker({
  value,
  onChange,
  options,
  selfId,
  labelId,
  describedBy,
  error,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  options: readonly ManagerOption[];
  selfId?: string;
  labelId: string;
  describedBy?: string;
  error?: string | null;
}) {
  const below = selfId ? descendantsOf(options, selfId) : new Set<string>();
  const groups = groupPositionsByCategory(options);
  const selected = options.find((option) => option.id === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-labelledby={labelId}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        }
      >
        <span className="truncate">{selected?.name ?? "No manager"}</span>
        <ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value ?? NO_MANAGER}
          onValueChange={(next: string) =>
            onChange(next === NO_MANAGER ? null : next)
          }
        >
          <DropdownMenuRadioItem value={NO_MANAGER}>
            No manager
          </DropdownMenuRadioItem>
          {groups.map((group) => (
            <DropdownMenuGroup key={group.category}>
              <DropdownMenuLabel>{group.category}</DropdownMenuLabel>
              {group.positions.map((option) => {
                const isSelf = option.id === selfId;
                const isBelow = below.has(option.id);
                return (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    disabled={isSelf || isBelow}
                  >
                    {option.name}
                    {isSelf ? " · this position" : null}
                    {isBelow ? " · reports to this position" : null}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
