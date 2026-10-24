import { describe, expect, it, vi } from "vitest";
import {
  buildRecoveryEmail,
  createResendSender,
} from "@/lib/break-glass/notify";

const details = {
  primaryAdminEmail: "new@northeastern.edu",
  previousPrimaryAdminEmail: "old@northeastern.edu",
  operator: "Ada Lovelace",
  reason: "Primary Admin unreachable",
  at: new Date("2026-10-21T12:00:00.000Z"),
};

describe("buildRecoveryEmail", () => {
  it("describes a transfer with both addresses, operator, reason and time", () => {
    const { subject, text } = buildRecoveryEmail("transfer", details);
    expect(subject).toBe(
      "SGAuth: Primary Admin changed by break-glass recovery",
    );
    expect(text).toContain(
      "changed from old@northeastern.edu to new@northeastern.edu",
    );
    expect(text).toContain("2026-10-21T12:00:00.000Z");
    expect(text).toContain("Operator: Ada Lovelace");
    expect(text).toContain("Reason: Primary Admin unreachable");
    expect(text).toContain("All sessions of old@northeastern.edu");
  });

  it("copes with there being no previous Primary Admin", () => {
    const { text } = buildRecoveryEmail("transfer", {
      ...details,
      previousPrimaryAdminEmail: null,
    });
    expect(text).toContain("set to new@northeastern.edu");
    expect(text).not.toContain("signed out");
  });

  it("describes an MFA reset", () => {
    const { subject, text } = buildRecoveryEmail("reset_mfa", details);
    expect(subject).toBe(
      "SGAuth: Primary Admin MFA reset by break-glass recovery",
    );
    expect(text).toContain("new@northeastern.edu");
    expect(text).toContain("enrol again");
  });

  it("never contains a link", () => {
    for (const kind of ["transfer", "reset_mfa"] as const) {
      expect(buildRecoveryEmail(kind, details).text).not.toMatch(/https?:\/\//);
    }
  });
});

describe("createResendSender", () => {
  const email = { subject: "s", text: "t" };

  it("posts one authorised message per recipient", async () => {
    const fetchFake = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = createResendSender({
      apiKey: "re_secret",
      from: "sgauth@example.com",
      fetch: fetchFake as unknown as typeof fetch,
    });

    const results = await send(["a@x.edu", "b@x.edu"], email);

    expect(results).toEqual([
      { to: "a@x.edu", status: "ok" },
      { to: "b@x.edu", status: "ok" },
    ]);
    expect(fetchFake).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFake.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_secret",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      from: "sgauth@example.com",
      to: ["a@x.edu"],
      subject: "s",
      text: "t",
    });
  });

  it("marks a rejected or throwing send as failed and keeps going", async () => {
    const fetchFake = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 422 }))
      .mockRejectedValueOnce(new Error("network down re_secret"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const send = createResendSender({
      apiKey: "re_secret",
      from: "sgauth@example.com",
      fetch: fetchFake as unknown as typeof fetch,
    });

    const results = await send(["a@x.edu", "b@x.edu", "c@x.edu"], email);

    expect(results).toEqual([
      { to: "a@x.edu", status: "failed" },
      { to: "b@x.edu", status: "failed" },
      { to: "c@x.edu", status: "ok" },
    ]);
    expect(JSON.stringify(results)).not.toContain("re_secret");
  });
});
