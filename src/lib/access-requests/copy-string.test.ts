import { describe, expect, it } from "vitest";
import { buildAccessRequestCopyString } from "@/lib/access-requests/copy-string";

const fields = {
  requesterName: "Alex Kim",
  positionName: "VP Finance",
  product: "Notion",
  access: "Edit access to the Finance workspace",
  // 12:30 PM Eastern (EST, UTC-5).
  createdAt: new Date("2026-03-05T17:30:00Z"),
};

describe("buildAccessRequestCopyString", () => {
  it("builds one line with the time in Eastern", () => {
    expect(buildAccessRequestCopyString(fields)).toMatch(
      /^Access request: Alex Kim \(VP Finance\) needs Edit access to the Finance workspace on Notion\. Submitted Mar 5, 2026, 12:30\sPM ET\.$/,
    );
  });

  it("names a tombstoned requester as a deleted user", () => {
    expect(
      buildAccessRequestCopyString({ ...fields, requesterName: null }),
    ).toContain("Access request: a deleted user (VP Finance) needs");
  });

  it("follows daylight saving time", () => {
    expect(
      buildAccessRequestCopyString({
        ...fields,
        createdAt: new Date("2026-07-05T16:30:00Z"),
      }),
    ).toMatch(/Submitted Jul 5, 2026, 12:30\sPM ET\.$/);
  });
});
