import { describe, expect, it } from "vitest";
import {
  confirmCopy,
  normalizeDraft,
  pendingLine,
  submitBlockReason,
  successToast,
} from "@/lib/admin/email-change-copy";

describe("email change copy", () => {
  it("trims and lower-cases the draft", () => {
    expect(normalizeDraft("  Jo@Northeastern.EDU ")).toBe(
      "jo@northeastern.edu",
    );
  });

  it("blocks a blank field", () => {
    expect(submitBlockReason("jo@gmail.com", "")).toBe(
      "Enter the new address.",
    );
    expect(submitBlockReason("jo@gmail.com", "   ")).toBe(
      "Enter the new address.",
    );
  });

  it("blocks the current address whatever its case or spacing", () => {
    expect(submitBlockReason("jo@gmail.com", " Jo@GMAIL.com ")).toBe(
      "That is already this user's email address.",
    );
  });

  it("allows a new address", () => {
    expect(submitBlockReason("jo@gmail.com", "jo@northeastern.edu")).toBeNull();
  });

  it("words the confirmation", () => {
    expect(confirmCopy("Jo", "jo@gmail.com", "jo@northeastern.edu")).toEqual({
      title: "Send a verification link to jo@northeastern.edu?",
      description:
        "Jo's address stays jo@gmail.com until they open the link. It lasts 24 hours. Any earlier pending request is cancelled.",
      label: "Send link",
    });
  });

  it("words the pending banner with the formatted expiry", () => {
    expect(
      pendingLine(
        {
          newEmail: "jo@northeastern.edu",
          expiresAt: "2026-11-02T17:00:00.000Z",
        },
        "jo@gmail.com",
      ),
    ).toBe(
      "Waiting for jo@northeastern.edu to confirm. The link expires Nov 2, 2026, 12:00 PM. Until then, jo@gmail.com keeps working. Sending another link replaces this one.",
    );
  });

  it("words the success toast", () => {
    expect(successToast("jo@northeastern.edu")).toBe(
      "Verification link sent to jo@northeastern.edu.",
    );
  });
});
