"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { emailConfirmed } from "@/lib/admin/transfer-view";

interface ConfirmEmailStepProps {
  recipientEmail: string;
  value: string;
  onChange: (value: string) => void;
}

export function ConfirmEmailStep({
  recipientEmail,
  value,
  onChange,
}: ConfirmEmailStepProps) {
  const [touched, setTouched] = useState(false);
  const mismatch =
    touched && value !== "" && !emailConfirmed(value, recipientEmail);

  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="confirm-email" className="leading-normal font-normal">
        Type{" "}
        <strong className="font-semibold break-all">{recipientEmail}</strong> to
        confirm.
      </Label>
      <Input
        id="confirm-email"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setTouched(true)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={mismatch}
        aria-describedby={mismatch ? "confirm-email-error" : undefined}
      />
      {mismatch ? (
        <p
          id="confirm-email-error"
          role="alert"
          className="text-sm text-destructive"
        >
          This doesn&apos;t match the recipient&apos;s email exactly.
        </p>
      ) : null}
    </div>
  );
}
