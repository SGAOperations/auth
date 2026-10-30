"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DisabledReason } from "@/components/admin/disabled-reason";
import { useAdminAction } from "@/hooks/use-admin-action";
import { updateProfile } from "../actions";

const NAME_MAX = 100;

export function ProfileForm({
  userId,
  email,
  name,
  preferredName,
  disabledReason,
}: {
  userId: string;
  email: string;
  name: string;
  preferredName: string | null;
  /** Why editing is off, or null when the admin may edit. */
  disabledReason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [values, setValues] = useState({
    name,
    preferredName: preferredName ?? "",
  });
  const [saved, setSaved] = useState({
    name,
    preferredName: preferredName ?? "",
  });

  const dirty =
    values.name !== saved.name || values.preferredName !== saved.preferredName;
  const nameMissing = values.name.trim() === "";
  const readOnly = disabledReason !== null;

  async function save(event: React.SyntheticEvent) {
    event.preventDefault();
    const submitted = values;
    await run(() => updateProfile(userId, submitted), {
      success: "Profile updated.",
      onSuccess: () => {
        const trimmed = {
          name: submitted.name.trim(),
          preferredName: submitted.preferredName.trim(),
        };
        setSaved(trimmed);
        setValues(trimmed);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          The name shown across SGA products. The preferred name, when set, is
          shown instead of the legal name.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-md gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={values.name}
              maxLength={NAME_MAX}
              disabled={readOnly || pending}
              aria-invalid={dirty && nameMissing}
              onChange={(event) =>
                setValues({ ...values, name: event.target.value })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-preferred-name">Preferred name</Label>
            <Input
              id="profile-preferred-name"
              value={values.preferredName}
              maxLength={NAME_MAX}
              disabled={readOnly || pending}
              onChange={(event) =>
                setValues({ ...values, preferredName: event.target.value })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" value={email} readOnly disabled />
            <p className="text-xs text-muted-foreground">
              Email changes aren&apos;t available here yet.
            </p>
          </div>
          <DisabledReason
            reason={
              disabledReason ??
              (dirty && nameMissing ? "Enter a name to save." : null)
            }
            busy={pending || !dirty}
          >
            {(controlProps) => (
              <Button type="submit" {...controlProps}>
                {pending ? "Saving…" : "Save"}
              </Button>
            )}
          </DisabledReason>
        </form>
      </CardContent>
    </Card>
  );
}
