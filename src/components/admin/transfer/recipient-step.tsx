"use client";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { RecipientOption } from "@/lib/admin/transfer-view";

interface RecipientStepProps {
  options: readonly RecipientOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// A native radio group: one tab stop, arrow keys, and a disabled state that
// assistive technology announces. Ineligible people stay in the list with the
// reason beside them, so an admin can see why someone can't be chosen.
export function RecipientStep({
  options,
  selectedId,
  onSelect,
}: RecipientStepProps) {
  const anyEligible = options.some(
    (option) => option.unavailableReason === null,
  );

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">
        Choose the new Primary Admin
      </legend>
      <div className="flex flex-col gap-2">
        {options.map((option) => {
          const disabled = option.unavailableReason !== null;
          const id = `recipient-${option.id}`;
          return (
            <Label
              key={option.id}
              htmlFor={id}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 font-normal",
                disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/50",
                selectedId === option.id && "border-ring bg-muted/50",
              )}
            >
              <input
                id={id}
                type="radio"
                name="recipient"
                value={option.id}
                checked={selectedId === option.id}
                disabled={disabled}
                onChange={() => onSelect(option.id)}
                className="mt-1 size-4 accent-primary"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{option.name}</span>
                <span className="text-sm break-all text-muted-foreground">
                  {option.email}
                </span>
                {option.unavailableReason ? (
                  <span className="text-sm text-muted-foreground">
                    {option.unavailableReason}
                  </span>
                ) : null}
              </span>
            </Label>
          );
        })}
      </div>
      {anyEligible ? null : (
        <p role="status" className="text-sm text-destructive">
          No admin can receive Primary Admin right now.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Only active admins with two-factor authentication can become Primary
        Admin. To add someone, grant them admin first.
      </p>
    </fieldset>
  );
}
