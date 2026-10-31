import { describe, expect, it } from "vitest";
import {
  PLAIN_LINKS,
  TOKEN_ACTIONS,
  TOKEN_LINK_PATHS,
  plainLinkUrl,
  resolveLinkTarget,
  tokenLinkUrl,
  type TokenActionName,
} from "@/lib/token-links/actions";

const ORIGIN = "https://auth.northeasternsga.com";

const ACTIONS = Object.keys(TOKEN_ACTIONS) as TokenActionName[];
const live = ACTIONS.filter((a) => TOKEN_ACTIONS[a].status === "live");

describe("registry", () => {
  it("has exactly six live actions today", () => {
    expect(live).toEqual([
      "verify-email",
      "reset-password",
      "set-password",
      "account-unlock",
      "email-change",
      "pa-transfer-cancel",
    ]);
  });

  it("registers the Primary Admin cancel link on a public page", () => {
    expect(TOKEN_ACTIONS["pa-transfer-cancel"].path).toBe("/transfer/cancel");
  });

  it("gives every action its own path", () => {
    const paths = ACTIONS.map((a) => TOKEN_ACTIONS[a].path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists every action path in TOKEN_LINK_PATHS", () => {
    expect([...TOKEN_LINK_PATHS].sort()).toEqual(
      ACTIONS.map((a) => TOKEN_ACTIONS[a].path).sort(),
    );
  });
});

describe("tokenLinkUrl", () => {
  it("builds the URL and encodes the token", () => {
    expect(tokenLinkUrl(ORIGIN, "verify-email", "a b/c+d")).toBe(
      `${ORIGIN}/verify-email?token=a%20b%2Fc%2Bd`,
    );
  });

  it("throws on an empty token", () => {
    expect(() => tokenLinkUrl(ORIGIN, "verify-email", "")).toThrow(
      "needs a token",
    );
  });
});

describe("plainLinkUrl", () => {
  it("joins the origin and the registered path", () => {
    expect(plainLinkUrl(ORIGIN, "sign-in")).toBe(
      `${ORIGIN}${PLAIN_LINKS["sign-in"].path}`,
    );
  });
});

describe("resolveLinkTarget", () => {
  it("accepts the live verify-email page with one token", () => {
    expect(
      resolveLinkTarget(
        "verify-email",
        "url",
        `${ORIGIN}/verify-email?token=t`,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts the plain sign-in link with no query", () => {
    expect(
      resolveLinkTarget("inactivity-notice", "signInUrl", `${ORIGIN}/sign-in`),
    ).toEqual({ ok: true });
  });

  it("reports unmapped for a field the template does not register", () => {
    expect(
      resolveLinkTarget(
        "verify-email",
        "other",
        `${ORIGIN}/verify-email?token=t`,
      ),
    ).toEqual({ ok: false, reason: "unmapped" });
    expect(
      resolveLinkTarget("account-locked", "url", `${ORIGIN}/x?token=t`),
    ).toEqual({ ok: false, reason: "unmapped" });
  });

  it("accepts the Primary Admin accept link as a plain link, and refuses a token on it", () => {
    expect(
      resolveLinkTarget(
        "pa-transfer-initiated",
        "url",
        `${ORIGIN}/admin/transfer/accept`,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveLinkTarget(
        "pa-transfer-initiated",
        "url",
        `${ORIGIN}/admin/transfer/accept?token=t`,
      ),
    ).toEqual({ ok: false, reason: "query" });
  });

  it("accepts the email-change link with one token, and no other path", () => {
    expect(
      resolveLinkTarget(
        "email-change-verify",
        "url",
        `${ORIGIN}/verify-email-change?token=t`,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveLinkTarget(
        "email-change-verify",
        "url",
        `${ORIGIN}/verify-email?token=t`,
      ),
    ).toEqual({ ok: false, reason: "path" });
  });

  it("accepts the Primary Admin cancel link with one token", () => {
    expect(
      resolveLinkTarget(
        "pa-transfer-accepted",
        "cancelUrl",
        `${ORIGIN}/transfer/cancel?token=t`,
      ),
    ).toEqual({ ok: true });
  });

  it("reports path for the wrong path", () => {
    expect(
      resolveLinkTarget(
        "verify-email",
        "url",
        `${ORIGIN}/api/auth/verify-email?token=t`,
      ),
    ).toEqual({ ok: false, reason: "path" });
    expect(resolveLinkTarget("verify-email", "url", "not a url")).toEqual({
      ok: false,
      reason: "path",
    });
  });

  it.each([
    ["an extra param", "/verify-email?token=t&callbackURL=%2F"],
    ["a missing token", "/verify-email"],
    ["an empty token", "/verify-email?token="],
    ["another param name", "/verify-email?code=t"],
  ])("reports query for %s", (_label, path) => {
    expect(
      resolveLinkTarget("verify-email", "url", `${ORIGIN}${path}`),
    ).toEqual({ ok: false, reason: "query" });
  });

  it("reports query for a token on a plain link", () => {
    expect(
      resolveLinkTarget(
        "inactivity-notice",
        "signInUrl",
        `${ORIGIN}/sign-in?token=t`,
      ),
    ).toEqual({ ok: false, reason: "query" });
  });
});
