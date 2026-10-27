import { NextRequest, NextResponse } from "next/server";
import { symmetricEncodeJWT } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRedirect,
  openRedirect,
  redirectCookieOptions,
  sealRedirect,
} from "@/lib/redirect/cookie";

const SECRET = "a-test-secret-that-is-long-enough-for-hmac";
const BASE = "https://auth.northeasternsga.com";
const TARGET = "https://vaultz.northeasternsga.com/purchases/42";

const config = {
  secret: SECRET,
  baseURL: BASE,
  sgauthOrigin: BASE,
  allowHttpProducts: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("sealRedirect and openRedirect", () => {
  it("round-trips the target", async () => {
    expect(await openRedirect(await sealRedirect(TARGET, SECRET), SECRET)).toBe(
      TARGET,
    );
  });

  it("rejects a tampered token", async () => {
    const token = await sealRedirect(TARGET, SECRET);
    const middle = Math.floor(token.length / 2);
    const swapped = token[middle] === "A" ? "B" : "A";
    expect(
      await openRedirect(
        `${token.slice(0, middle)}${swapped}${token.slice(middle + 1)}`,
        SECRET,
      ),
    ).toBeNull();
  });

  it("rejects a different secret", async () => {
    const token = await sealRedirect(TARGET, SECRET);
    expect(await openRedirect(token, `${SECRET}-other`)).toBeNull();
  });

  it("rejects a token sealed under another salt", async () => {
    const token = await symmetricEncodeJWT(
      { t: TARGET },
      SECRET,
      "other",
      3600,
    );
    expect(await openRedirect(token, SECRET)).toBeNull();
  });

  it("rejects a payload without a string target", async () => {
    const token = await symmetricEncodeJWT(
      { t: 1 },
      SECRET,
      "sgauth.post-login-redirect",
      3600,
    );
    expect(await openRedirect(token, SECRET)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await openRedirect("not-a-token", SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await sealRedirect(TARGET, SECRET);
    vi.setSystemTime(new Date("2026-01-01T01:00:20Z"));
    expect(await openRedirect(token, SECRET)).toBeNull();
  });
});

describe("redirectCookieOptions", () => {
  it("is a host-only __Host- cookie over https", () => {
    expect(redirectCookieOptions(BASE)).toEqual({
      name: "__Host-sgauth.redirect",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
  });

  it("drops the prefix and Secure on local http", () => {
    expect(
      redirectCookieOptions("http://auth.sga.localhost:3000"),
    ).toMatchObject({ name: "sgauth.redirect", secure: false });
  });
});

describe("captureRedirect", () => {
  const NAME = "__Host-sgauth.redirect";

  async function run(query: string) {
    const request = new NextRequest(`${BASE}/login${query}`);
    const response = NextResponse.next();
    await captureRedirect(request, response, config);
    return response;
  }

  it("seals a valid target without a Domain", async () => {
    const response = await run(
      `?redirect=${encodeURIComponent(`${TARGET}#x`)}`,
    );
    const cookie = response.cookies.get(NAME);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(cookie?.domain).toBeUndefined();
    expect(await openRedirect(cookie?.value ?? "", SECRET)).toBe(TARGET);
  });

  it("leaves the cookie alone when the param is absent", async () => {
    const response = await run("");
    expect(response.cookies.get(NAME)).toBeUndefined();
  });

  it("clears the cookie when the target is malformed", async () => {
    const response = await run("?redirect=%2F%2Fevil.com");
    expect(response.cookies.get(NAME)).toMatchObject({ value: "", maxAge: 0 });
  });
});
