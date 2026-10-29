"use client";

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { positionKeyIssue, sanitizeKeyInput } from "@/lib/position-key";
import { KEY_ISSUE_MESSAGES } from "@/lib/position-view";

export const KEY_RULE =
  "2–64 characters: lowercase letters, numbers, and single hyphens between words. Can't be changed after the position is created.";

export const KEY_CONVENTION =
  "Organization roles use bare keys (vp-finance). Product roles start with the product slug (aplio-admin).";

/**
 * The key input. Every change is sanitized, so a rejected character is
 * announced instead of typed. `serverError` is the API's verdict on the last
 * submit; the parent clears it when the key changes.
 */
export function PositionKeyField({
  value,
  onChange,
  serverError,
}: {
  value: string;
  onChange: (value: string) => void;
  serverError: string | null;
}) {
  const id = useId();
  const ruleId = `${id}-rule`;
  const errorId = `${id}-error`;
  const [rejected, setRejected] = useState(false);
  const [touched, setTouched] = useState(false);

  const issue = positionKeyIssue(value);
  const structural = touched && issue ? KEY_ISSUE_MESSAGES[issue] : null;
  const error = serverError ?? structural;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Key</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => {
          const next = sanitizeKeyInput(event.target.value);
          setRejected(next.rejected);
          setTouched(true);
          onChange(next.value);
        }}
        onBlur={() => setTouched(true)}
        className="font-mono"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ruleId} ${errorId}` : ruleId}
      />
      <p id={ruleId} className="text-xs text-muted-foreground">
        {KEY_RULE}
      </p>
      <p className="text-xs text-muted-foreground">{KEY_CONVENTION}</p>
      <p aria-live="polite" className="text-xs text-destructive">
        {rejected ? KEY_ISSUE_MESSAGES.INVALID_CHARS : ""}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
