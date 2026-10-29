"use client";

import Form from "next/form";
import Link from "next/link";
import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_EVENT_TYPES,
  AUDIT_TARGET_TYPES,
} from "@/lib/audit-catalog";
import { cn } from "@/lib/utils";

export interface AuditFilterValues {
  type: string[];
  user: string;
  userRole: string;
  actorType: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}

export type AuditFieldErrors = Partial<
  Record<"type" | "user" | "targetType" | "targetId" | "from" | "to", string>
>;

const ACTOR_LABELS: Record<(typeof AUDIT_ACTOR_TYPES)[number], string> = {
  USER: "User",
  SYSTEM: "System",
  BREAK_GLASS: "Break-glass",
};

const TARGET_LABELS: Record<(typeof AUDIT_TARGET_TYPES)[number], string> = {
  USER: "User",
  POSITION: "Position",
  PRODUCT: "Product",
  SESSION: "Session",
  TRANSFER: "Transfer",
};

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30";

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuditFilters({
  values,
  errors,
  userNote,
}: {
  values: AuditFilterValues;
  errors: AuditFieldErrors;
  /** Shown under the User field, e.g. when no user has the email. */
  userNote?: string;
}) {
  const [types, setTypes] = useState<string[]>(values.type);
  const [user, setUser] = useState(values.user);

  const describe = (id: keyof AuditFieldErrors) =>
    errors[id]
      ? { "aria-describedby": `${id}-error`, "aria-invalid": true }
      : {};

  return (
    <Form
      action="/admin/audit"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Field id="type" label="Event types" error={errors.type}>
        <DropdownMenu>
          <DropdownMenuTrigger
            id="type"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "w-full justify-between",
            )}
            {...describe("type")}
          >
            {types.length === 0 ? "All events" : `${types.length} selected`}
            <ChevronDownIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-80 min-w-64">
            {AUDIT_EVENT_TYPES.map((type) => (
              <DropdownMenuCheckboxItem
                key={type}
                checked={types.includes(type)}
                onCheckedChange={(checked) =>
                  setTypes((current) =>
                    checked
                      ? [...current, type]
                      : current.filter((entry) => entry !== type),
                  )
                }
                className="font-mono text-xs"
              >
                {type}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {types.map((type) => (
          <input key={type} type="hidden" name="type" value={type} />
        ))}
      </Field>

      <Field id="user" label="User" error={errors.user ?? userNote}>
        <Input
          id="user"
          name="user"
          placeholder="Email or user ID"
          value={user}
          onChange={(event) => setUser(event.target.value)}
          maxLength={254}
          autoComplete="off"
          {...describe("user")}
        />
      </Field>

      <Field id="userRole" label="User role">
        <select
          id="userRole"
          name="userRole"
          defaultValue={values.userRole}
          disabled={user.trim() === ""}
          className={SELECT_CLASS}
        >
          <option value="any">Performed or targeted</option>
          <option value="actor">Performed by</option>
          <option value="target">Targeted</option>
        </select>
      </Field>

      <Field id="actorType" label="Actor type">
        <select
          id="actorType"
          name="actorType"
          defaultValue={values.actorType}
          className={SELECT_CLASS}
        >
          <option value="">Any actor</option>
          {AUDIT_ACTOR_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACTOR_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>

      <Field id="targetType" label="Target type" error={errors.targetType}>
        <select
          id="targetType"
          name="targetType"
          defaultValue={values.targetType}
          className={SELECT_CLASS}
          {...describe("targetType")}
        >
          <option value="">Any target</option>
          {AUDIT_TARGET_TYPES.map((type) => (
            <option key={type} value={type}>
              {TARGET_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>

      <Field id="targetId" label="Target ID" error={errors.targetId}>
        <Input
          id="targetId"
          name="targetId"
          defaultValue={values.targetId}
          maxLength={200}
          autoComplete="off"
          {...describe("targetId")}
        />
      </Field>

      <Field id="from" label="From" error={errors.from}>
        <Input
          id="from"
          name="from"
          type="date"
          defaultValue={values.from}
          {...describe("from")}
        />
      </Field>

      <Field id="to" label="To" error={errors.to}>
        <Input
          id="to"
          name="to"
          type="date"
          defaultValue={values.to}
          {...describe("to")}
        />
      </Field>

      <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit">Apply filters</Button>
        <Link
          href="/admin/audit"
          className={buttonVariants({ variant: "ghost" })}
        >
          Clear
        </Link>
      </div>
    </Form>
  );
}
