"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/policy";
import { passwordLengthMessage, passwordLengthState } from "@/lib/auth/forms";
import { cn } from "@/lib/utils";

type PasswordFieldProps = Omit<ComponentProps<typeof Input>, "type"> & {
  /** Live "n / 12" count and a once-per-threshold announcement. */
  showLengthFeedback?: boolean;
};

// Works both inside react-hook-form's FormControl (controlled) and as a plain
// named input in a native form (uncontrolled): the count follows the input's
// own change events either way.
export function PasswordField({
  showLengthFeedback = false,
  className,
  onChange,
  value,
  defaultValue,
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const [typedLength, setTypedLength] = useState(
    String(defaultValue ?? "").length,
  );
  const length = value === undefined ? typedLength : String(value).length;
  const state = passwordLengthState(length);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          {...props}
          type={visible ? "text" : "password"}
          value={value}
          defaultValue={defaultValue}
          className={cn("pr-10", className)}
          onChange={(event) => {
            setTypedLength(event.currentTarget.value.length);
            onChange?.(event);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-0.5 right-0.5"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
      {showLengthFeedback ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {/* Changes only when the state does, so a screen reader hears one
              update at each threshold, not one per keystroke. */}
          <span aria-live="polite">{passwordLengthMessage(state)}</span>
          <span aria-hidden="true">
            {length} / {PASSWORD_MIN_LENGTH}
          </span>
        </div>
      ) : null}
    </div>
  );
}
