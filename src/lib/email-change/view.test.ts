import { describe, expect, it, vi } from "vitest";
import type { PeekEmailChangeResult } from "@/lib/email-change/service";
import { loadEmailChangeView } from "@/lib/email-change/view";

const peekReturning = (result: PeekEmailChangeResult) =>
  vi.fn().mockResolvedValue(result);

describe("loadEmailChangeView", () => {
  it("is ready, with the new address, for a live token", async () => {
    const peek = peekReturning({ state: "valid", newEmail: "n@gmail.com" });
    expect(await loadEmailChangeView({ token: "t" }, peek)).toEqual({
      state: "ready",
      token: "t",
      newEmail: "n@gmail.com",
    });
    expect(peek).toHaveBeenCalledWith("t");
  });

  it.each(["expired", "used", "invalid"] as const)(
    "reports %s from the peek",
    async (state) => {
      expect(
        await loadEmailChangeView({ token: "t" }, peekReturning({ state })),
      ).toEqual({ state });
    },
  );

  it("is invalid with no token, or a token that is not a string", async () => {
    const peek = peekReturning({ state: "valid", newEmail: "n@gmail.com" });
    expect(await loadEmailChangeView({}, peek)).toEqual({ state: "invalid" });
    expect(await loadEmailChangeView({ token: ["a", "b"] }, peek)).toEqual({
      state: "invalid",
    });
    expect(peek).not.toHaveBeenCalled();
  });

  it("shows a result without reading the token", async () => {
    const peek = peekReturning({ state: "valid", newEmail: "n@gmail.com" });
    expect(
      await loadEmailChangeView({ token: "t", result: "done" }, peek),
    ).toEqual({ state: "done" });
    expect(peek).not.toHaveBeenCalled();
  });

  it("shows unavailable after a refused confirm, and the form error after a bad form", async () => {
    const peek = peekReturning({ state: "valid", newEmail: "n@gmail.com" });
    expect(
      await loadEmailChangeView({ token: "t", error: "unavailable" }, peek),
    ).toEqual({ state: "unavailable" });
    expect(
      await loadEmailChangeView({ token: "t", error: "fields" }, peek),
    ).toEqual({
      state: "ready",
      token: "t",
      newEmail: "n@gmail.com",
      error: "fields",
    });
  });

  it("re-reads the token after an expired confirm", async () => {
    expect(
      await loadEmailChangeView(
        { token: "t", error: "expired" },
        peekReturning({ state: "expired" }),
      ),
    ).toEqual({ state: "expired" });
  });

  it("is invalid for an unknown result or error value", async () => {
    const peek = peekReturning({ state: "valid", newEmail: "n@gmail.com" });
    expect(
      await loadEmailChangeView({ token: "t", result: "weird" }, peek),
    ).toEqual({ state: "invalid" });
    expect(
      await loadEmailChangeView({ token: "t", error: "weird" }, peek),
    ).toEqual({ state: "invalid" });
  });
});
