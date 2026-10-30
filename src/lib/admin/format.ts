// Pure and client-safe. Times show in Eastern, as the audit log does.

const TIME_ZONE = "America/New_York";

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  dateStyle: "medium",
});

const timeOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  timeStyle: "short",
});

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatDate = (iso: string) => dateOnly.format(new Date(iso));
export const formatTime = (iso: string) => timeOnly.format(new Date(iso));

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "3 days ago", "in 2 hours", or "just now" inside the last minute. */
export function formatRelative(iso: string, now: Date): string {
  const diff = new Date(iso).getTime() - now.getTime();
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) {
      return relative.format(Math.trunc(diff / size), unit);
    }
  }
  return "just now";
}
