import { describe, expect, it } from "vitest";
import {
  expireSessionCookies,
  requestOrigin,
  sortSessionViews,
  toSessionView,
  type AuthCookies,
  type SessionView,
} from "@/lib/sessions/own-sessions";

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe("requestOrigin", () => {
  it("prefers Origin", () => {
    expect(
      requestOrigin(
        headers({
          origin: "https://a.example",
          referer: "https://b.example/x",
        }),
      ),
    ).toBe("https://a.example");
  });

  it("falls back to Referer when Origin is the string null", () => {
    expect(
      requestOrigin(
        headers({ origin: "null", referer: "https://b.example/x?y=1" }),
      ),
    ).toBe("https://b.example");
  });

  it("returns null for a malformed Referer and for nothing", () => {
    expect(requestOrigin(headers({ referer: "not a url" }))).toBeNull();
    expect(requestOrigin(headers({}))).toBeNull();
  });
});

describe("toSessionView", () => {
  const row = {
    id: "0190a000-0000-7000-8000-000000000001",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ipAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; rv:127.0) Firefox/127.0",
  };

  it("maps the row and flags only the current session", () => {
    expect(toSessionView(row, row.id)).toEqual({
      id: row.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-02T00:00:00.000Z",
      ip: "203.0.113.9",
      device: "Firefox on Windows",
      isCurrent: true,
    });
    expect(toSessionView(row, "other").isCurrent).toBe(false);
  });

  it("turns an empty ip into null and never carries a token", () => {
    const view = toSessionView({ ...row, ipAddress: "" }, row.id);
    expect(view.ip).toBeNull();
    expect(Object.keys(view)).not.toContain("token");
  });
});

describe("sortSessionViews", () => {
  const view = (
    id: string,
    lastActiveAt: string,
    isCurrent = false,
  ): SessionView => ({
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt,
    ip: null,
    device: "Unknown device",
    isCurrent,
  });

  it("puts the current session first, then most recent activity", () => {
    const sorted = sortSessionViews([
      view("old", "2026-01-01T00:00:00.000Z"),
      view("current", "2026-01-01T00:00:00.000Z", true),
      view("new", "2026-01-05T00:00:00.000Z"),
    ]);
    expect(sorted.map((v) => v.id)).toEqual(["current", "new", "old"]);
  });

  it("does not mutate its input", () => {
    const input = [view("a", "2026-01-01T00:00:00.000Z")];
    expect(sortSessionViews(input)).not.toBe(input);
  });
});

describe("expireSessionCookies", () => {
  const attributes = {
    domain: "northeasternsga.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  };
  const authCookies: AuthCookies = {
    sessionToken: {
      name: "__Secure-sgauth.session_token",
      attributes,
    },
    sessionData: { name: "__Secure-sgauth.session_data", attributes },
    dontRememberToken: {
      name: "__Secure-sgauth.dont_remember",
      attributes,
    },
  };

  it("expires all three cookies with the live attributes", () => {
    const out = new Headers();
    expireSessionCookies(out, authCookies);
    const cookies = out.getSetCookie();
    expect(cookies).toHaveLength(3);
    for (const [index, name] of [
      "__Secure-sgauth.session_token",
      "__Secure-sgauth.session_data",
      "__Secure-sgauth.dont_remember",
    ].entries()) {
      expect(cookies[index]).toBe(
        `${name}=; Max-Age=0; Domain=northeasternsga.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
      );
    }
  });
});
