"use client";

import { useId, type ReactNode } from "react";

interface ControlProps {
  disabled: boolean;
  "aria-describedby"?: string;
}

/**
 * Pairs a control with the reason it is disabled. A disabled button fires no
 * pointer or focus events, so a tooltip on it would be unreachable; the reason
 * is plain text beside the control instead, tied to it with `aria-describedby`.
 * With no reason the control is enabled and nothing extra renders.
 */
export function DisabledReason({
  reason,
  busy = false,
  children,
}: {
  reason: string | null;
  /** Disables the control without a reason, while an action runs. */
  busy?: boolean;
  children: (props: ControlProps) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-1">
      {children({
        disabled: reason !== null || busy,
        "aria-describedby": reason ? id : undefined,
      })}
      {reason ? (
        <p id={id} className="text-xs text-muted-foreground">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
