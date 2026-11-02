import { describe, expect, it } from "vitest";
import {
  canSubmitDelete,
  DELETE_NEEDS_DEACTIVATION,
  deleteDialogCopy,
  deleteReason,
} from "@/lib/admin/delete-user";
import { REASON_COPY } from "@/lib/admin/denial-copy";

describe("deleteReason", () => {
  it("lets a can() reason win over the status", () => {
    expect(deleteReason(REASON_COPY.SELF_MODIFICATION, "ACTIVE")).toBe(
      REASON_COPY.SELF_MODIFICATION,
    );
    expect(deleteReason(REASON_COPY.SELF_MODIFICATION, "DEACTIVATED")).toBe(
      REASON_COPY.SELF_MODIFICATION,
    );
    expect(deleteReason(REASON_COPY.PRIMARY_ADMIN_PROTECTED, "ACTIVE")).toBe(
      REASON_COPY.PRIMARY_ADMIN_PROTECTED,
    );
    expect(
      deleteReason(REASON_COPY.PRIMARY_ADMIN_PROTECTED, "DEACTIVATED"),
    ).toBe(REASON_COPY.PRIMARY_ADMIN_PROTECTED);
  });

  it("asks for deactivation first on an active user", () => {
    expect(deleteReason(null, "ACTIVE")).toBe(DELETE_NEEDS_DEACTIVATION);
    expect(DELETE_NEEDS_DEACTIVATION).toBe(
      "Deactivate this account before deleting it.",
    );
  });

  it("offers delete on a deactivated user", () => {
    expect(deleteReason(null, "DEACTIVATED")).toBeNull();
  });
});

describe("canSubmitDelete", () => {
  const email = "pat@northeastern.edu";

  it("is false until the email matches exactly", () => {
    expect(canSubmitDelete("", email, false)).toBe(false);
    expect(canSubmitDelete("pat@north", email, false)).toBe(false);
    expect(canSubmitDelete("Pat@northeastern.edu", email, false)).toBe(false);
    expect(canSubmitDelete("sam@northeastern.edu", email, false)).toBe(false);
  });

  it("is true for an exact match, outer spaces aside", () => {
    expect(canSubmitDelete(email, email, false)).toBe(true);
    expect(canSubmitDelete(`  ${email} `, email, false)).toBe(true);
  });

  it("is false while an action is pending", () => {
    expect(canSubmitDelete(email, email, true)).toBe(false);
  });
});

describe("deleteDialogCopy", () => {
  it("names the user in the title", () => {
    expect(deleteDialogCopy("Pat Lee").title).toBe(
      "Delete Pat Lee permanently?",
    );
  });

  it("lists exactly what the tombstone does", () => {
    const copy = deleteDialogCopy("Pat Lee");
    expect(copy.label).toBe("Delete account");
    expect(copy.consequences).toEqual([
      "Remove their name and email.",
      "Remove their password, two-factor, passkeys and remembered devices.",
      "End every session and remove all of their positions.",
      "Keep their account ID, so products show them as 'Deleted user'.",
    ]);
  });
});
