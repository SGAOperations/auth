import { describe, expect, it } from "vitest";
import {
  formatAccessRequest,
  formatAccessRequestTime,
} from "@/lib/access-requests/format";

const base = {
  requester: {
    name: "Jane Doe",
    preferredName: null,
    email: "jane@northeastern.edu",
  },
  positionName: "Information Manager",
  product: "Notion",
  access: "Editor on the Ops workspace",
  createdAt: new Date("2026-11-07T19:03:00Z"),
};

describe("formatAccessRequest", () => {
  it("builds the exact one-line string", () => {
    expect(formatAccessRequest(base)).toBe(
      "Requester: Jane Doe <jane@northeastern.edu> | Position: Information Manager | Product: Notion | Access: Editor on the Ops workspace | Submitted: 2026-11-07 14:03 ET",
    );
  });

  it("prefers the preferred name", () => {
    const text = formatAccessRequest({
      ...base,
      requester: { ...base.requester, preferredName: "Janie" },
    });
    expect(text).toContain("Requester: Janie <jane@northeastern.edu>");
  });

  it("says Deleted user when there is no requester", () => {
    expect(formatAccessRequest({ ...base, requester: null })).toContain(
      "Requester: Deleted user | Position:",
    );
  });

  it("collapses newlines and repeated spaces in free text", () => {
    const text = formatAccessRequest({
      ...base,
      product: "  No\n\ntion  ",
      access: "Editor\r\n  on   the\tOps\nworkspace ",
    });
    expect(text).toContain("Product: No tion |");
    expect(text).toContain("Access: Editor on the Ops workspace |");
    expect(text).not.toMatch(/[\r\n\t]/);
  });
});

describe("formatAccessRequestTime", () => {
  it("gives EDT in July", () => {
    expect(formatAccessRequestTime(new Date("2026-07-15T16:30:00Z"))).toBe(
      "2026-07-15 12:30 ET",
    );
  });

  it("gives EST in January", () => {
    expect(formatAccessRequestTime(new Date("2026-01-15T16:30:00Z"))).toBe(
      "2026-01-15 11:30 ET",
    );
  });

  it("uses 00:05, not 24:05, just after midnight", () => {
    expect(formatAccessRequestTime(new Date("2026-01-15T05:05:00Z"))).toBe(
      "2026-01-15 00:05 ET",
    );
  });
});
