// Pure and client-safe: no `server-only`.
import { displayName } from "@/lib/user-display";

/** Matches `AUDIT_TIME_ZONE`, which is not imported because `audit-log.ts` is server-only. */
export const ACCESS_REQUEST_TIME_ZONE = "America/New_York";

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ACCESS_REQUEST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD HH:mm ET`, in 24-hour Eastern time. */
export function formatAccessRequestTime(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of timeFormat.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface FormattableAccessRequest {
  /** `null` for a deleted requester. */
  requester: {
    name: string;
    preferredName: string | null;
    email: string;
  } | null;
  positionName: string;
  product: string;
  access: string;
  createdAt: Date;
}

/**
 * The single-line, copyable text of a request. Free-text fields have every run
 * of whitespace, newlines included, collapsed to one space.
 */
export function formatAccessRequest(input: FormattableAccessRequest): string {
  const requester = input.requester
    ? `${oneLine(displayName(input.requester))} <${oneLine(input.requester.email)}>`
    : "Deleted user";
  return [
    `Requester: ${requester}`,
    `Position: ${oneLine(input.positionName)}`,
    `Product: ${oneLine(input.product)}`,
    `Access: ${oneLine(input.access)}`,
    `Submitted: ${formatAccessRequestTime(input.createdAt)}`,
  ].join(" | ");
}
