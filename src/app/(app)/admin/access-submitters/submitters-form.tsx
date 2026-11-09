"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  MAX_SUBMITTER_POSITIONS,
  sameKeySet,
} from "@/lib/access-submitters-input";
import {
  SUBMITTER_FAILURE_COPY,
  SUBMITTER_UNEXPECTED_COPY,
  filterOptions,
  groupByCategory,
  toggleKey,
  type SubmitterOption,
} from "@/lib/admin/access-submitters-form";
import { saveSubmitterPositions } from "./actions";

export function SubmittersForm({
  options,
  current,
}: {
  options: readonly SubmitterOption[];
  current: readonly string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<readonly string[]>(current);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);

  const groups = groupByCategory(filterOptions(options, filter));
  const atCap = selected.length >= MAX_SUBMITTER_POSITIONS;
  const unchanged = sameKeySet(selected, current);

  async function onSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await saveSubmitterPositions({ keys: [...selected] });
      if (result.ok) {
        setRemovedKeys([]);
        toast.success(
          result.unchanged ? "No changes to save." : "Changes saved.",
        );
        router.refresh();
        return;
      }
      if (result.code === "UNKNOWN_POSITION") {
        setSelected((keys) =>
          keys.filter((key) => !result.unknownKeys.includes(key)),
        );
        setRemovedKeys(result.unknownKeys);
        router.refresh();
        return;
      }
      toast.error(SUBMITTER_FAILURE_COPY[result.code]);
    } catch {
      toast.error(SUBMITTER_UNEXPECTED_COPY);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
      <Input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter positions"
        aria-label="Filter positions"
      />
      <div className="max-h-96 overflow-y-auto rounded-lg border p-3">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No positions match.</p>
        ) : (
          groups.map(([category, entries]) => (
            <fieldset key={category} className="mb-3 last:mb-0">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">
                {category}
              </legend>
              <div className="flex flex-col gap-1">
                {entries.map((option) => {
                  const checked = selected.includes(option.key);
                  return (
                    <label
                      key={option.key}
                      className="flex min-h-11 items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={atCap && !checked}
                        onCheckedChange={(next) =>
                          setSelected((keys) =>
                            toggleKey(keys, option.key, next),
                          )
                        }
                      />
                      <span>{option.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {option.key}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))
        )}
      </div>

      <p aria-live="polite" className="text-sm text-muted-foreground">
        {atCap
          ? `${selected.length} of ${MAX_SUBMITTER_POSITIONS} selected. Uncheck one to choose another.`
          : `${selected.length} of ${MAX_SUBMITTER_POSITIONS} selected`}
      </p>

      {removedKeys.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          Some positions were deleted while you were editing and have been
          unchecked:{" "}
          {removedKeys.map((key, index) => (
            <span key={key}>
              {index > 0 ? ", " : ""}
              <code className="font-mono">{key}</code>
            </span>
          ))}
          . Review the list and save again.
        </p>
      ) : null}

      <div className="flex flex-col items-start gap-2">
        <Button type="submit" disabled={saving || unchanged}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Every change is recorded in the{" "}
          <Link
            href="/admin/audit?type=ACCESS_SUBMITTERS_UPDATED"
            className="underline underline-offset-4"
          >
            audit log
          </Link>
          .
        </p>
      </div>
    </form>
  );
}
