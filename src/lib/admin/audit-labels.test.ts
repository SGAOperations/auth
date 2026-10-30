import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES } from "@/lib/audit-catalog";
import {
  AUDIT_LABELS,
  auditDetail,
  auditLabel,
} from "@/lib/admin/audit-labels";

describe("auditLabel", () => {
  it("names every catalog type", () => {
    for (const type of AUDIT_EVENT_TYPES) {
      expect(AUDIT_LABELS[type].trim(), type).not.toBe("");
      expect(auditLabel(type)).toBe(AUDIT_LABELS[type]);
    }
  });

  it("falls back to the raw type for one the catalog lacks", () => {
    expect(auditLabel("OLD_EVENT")).toBe("OLD_EVENT");
    expect(auditLabel("toString")).toBe("toString");
  });
});

describe("auditDetail", () => {
  it("lists the changed profile fields", () => {
    expect(
      auditDetail("USER_UPDATED", { fields: ["name", "preferredName"] }),
    ).toBe("Changed name and preferred name");
  });

  it("counts the sessions a deactivation ended", () => {
    expect(auditDetail("USER_DEACTIVATED", { revokedSessions: 1 })).toBe(
      "1 session ended",
    );
    expect(auditDetail("USER_DEACTIVATED", { revokedSessions: 3 })).toBe(
      "3 sessions ended",
    );
  });

  it("shows the position name for an assignment", () => {
    expect(
      auditDetail(
        "POSITION_ASSIGNED",
        { positionId: "x" },
        "Treasurer (treasurer)",
      ),
    ).toBe("Treasurer (treasurer)");
    expect(auditDetail("POSITION_ASSIGNED", { positionId: "x" })).toBeNull();
  });

  it("has nothing to say about other events or odd metadata", () => {
    expect(auditDetail("LOGOUT", {})).toBeNull();
    expect(auditDetail("USER_UPDATED", null)).toBeNull();
    expect(auditDetail("USER_UPDATED", [])).toBeNull();
  });
});
