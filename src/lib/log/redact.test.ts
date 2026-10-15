import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "@/lib/log/redact";

describe("redact", () => {
  it("redacts sensitive keys at any depth and inside arrays", () => {
    const result = redact({
      a: { password: "p1", nested: [{ token: "t1", keep: "ok" }] },
    });
    expect(result).toEqual({
      a: { password: REDACTED, nested: [{ token: REDACTED, keep: "ok" }] },
    });
  });

  it("matches keys case-insensitively and ignores separators", () => {
    const result = redact({
      "Set-Cookie": "a=1",
      session_token: "s",
      NEWPASSWORD: "n",
      BETTER_AUTH_SECRET: "x",
      clientSecret: "c",
      accessToken: "t",
      Authorization: "a",
    });
    expect(Object.values(result as Record<string, unknown>)).toEqual(
      Array(7).fill(REDACTED),
    );
  });

  it("redacts email, body and one-time-code keys whatever their type", () => {
    const result = redact({
      email: "a@b.co",
      html: "<p>hi</p>",
      text: "hi",
      body: { x: 1 },
      otp: 123456,
      code: "999",
      ip: "1.2.3.4",
    });
    expect(Object.values(result as Record<string, unknown>)).toEqual(
      Array(7).fill(REDACTED),
    );
  });

  it("redacts a JWT or Bearer value under an innocuous key", () => {
    const result = redact({
      a: "eyJhbGciOiJIUzI1NiJ9.e30.SIG",
      b: "Bearer abc.def",
      c: "bearer lowercase",
    });
    expect(result).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED });
  });

  it("masks an email address inside a sentence", () => {
    expect(redact({ note: "user x@northeastern.edu failed" })).toEqual({
      note: "user [REDACTED_EMAIL] failed",
    });
  });

  it("keeps an error's name and masks an email in its message", () => {
    const error = new TypeError("bad input from x@northeastern.edu", {
      cause: new Error("inner x@northeastern.edu"),
    });
    const result = redact({ err: error }) as {
      err: { name: string; message: string; stack: string; cause: unknown };
    };
    expect(result.err.name).toBe("TypeError");
    expect(result.err.message).toBe("bad input from [REDACTED_EMAIL]");
    expect(result.err.stack).not.toContain("x@northeastern.edu");
    expect(JSON.stringify(result.err.cause)).not.toContain(
      "x@northeastern.edu",
    );
  });

  it("replaces a cycle and truncates past the depth limit", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: "loop", self: "[Circular]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain("[Truncated]");
  });

  it("does not flag a shared, non-cyclic reference", () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({
      a: { v: 1 },
      b: { v: 1 },
    });
  });

  it("converts dates and bigints and drops functions", () => {
    const result = redact({
      at: new Date("2026-01-02T03:04:05.000Z"),
      big: BigInt(10),
      fn: () => 1,
    });
    expect(result).toEqual({
      at: "2026-01-02T03:04:05.000Z",
      big: "10",
      fn: undefined,
    });
  });

  it("never mutates its input", () => {
    const input = { password: "p", nested: { token: "t", list: ["a@b.co"] } };
    const snapshot = structuredClone(input);
    redact(input);
    expect(input).toEqual(snapshot);
  });
});
