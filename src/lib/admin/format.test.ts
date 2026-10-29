import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelative, formatTime } from "@/lib/admin/format";

const NOW = new Date("2026-10-29T18:00:00.000Z");

describe("formatRelative", () => {
  it("rounds toward zero into the largest fitting unit", () => {
    expect(formatRelative("2026-10-26T18:00:00.000Z", NOW)).toBe("3 days ago");
    expect(formatRelative("2026-10-29T15:30:00.000Z", NOW)).toBe("2 hours ago");
    expect(formatRelative("2026-10-29T18:10:00.000Z", NOW)).toBe(
      "in 10 minutes",
    );
  });

  it("says just now inside a minute", () => {
    expect(formatRelative("2026-10-29T17:59:30.000Z", NOW)).toBe("just now");
  });
});

describe("Eastern formatting", () => {
  it("formats in America/New_York", () => {
    // Newer ICU puts a narrow no-break space before the meridiem.
    expect(formatTime("2026-10-29T19:42:00.000Z").replace(/\s/g, " ")).toBe(
      "3:42 PM",
    );
    expect(formatDateTime("2026-10-29T19:42:00.000Z")).toContain(
      "Oct 29, 2026",
    );
  });
});
