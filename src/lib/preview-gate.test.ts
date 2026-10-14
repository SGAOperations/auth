import { describe, expect, it } from "vitest";
import {
  GATE_MAX_AGE,
  createAttemptLimiter,
  clientIp,
  deriveGateKey,
  isExemptPath,
  isGatePath,
  passwordMatches,
  safeNextPath,
  signGateCookie,
  verifyGateCookie,
} from "@/lib/preview-gate";

const SECRET = "s".repeat(32);
const PASSWORD = "p".repeat(16);
const NOW = 1_800_000_000;
const KEY = deriveGateKey(SECRET, PASSWORD);

const EXEMPT = [
  "/api/auth/ok",
  "/api/auth/jwks",
  "/api/auth/token",
  "/api/auth/get-session",
  "/api/sgauth/session",
  "/api/health",
  "/.well-known/jwks.json",
  "/.well-known/openid-configuration",
];

describe("isExemptPath", () => {
  it.each(EXEMPT)("exempts %s with and without a trailing slash", (path) => {
    expect(isExemptPath(path)).toBe(true);
    expect(isExemptPath(`${path}/`)).toBe(true);
  });

  it.each([
    "/",
    "/login",
    "/api/auth/okay",
    "/api/auth/jwks/x",
    "/api/auth/sign-in/email",
  ])("gates %s", (path) => {
    expect(isExemptPath(path)).toBe(false);
  });
});

describe("isGatePath", () => {
  it("matches the gate page and the unlock handler only", () => {
    expect(isGatePath("/preview-gate")).toBe(true);
    expect(isGatePath("/preview-gate/")).toBe(true);
    expect(isGatePath("/preview-gate/unlock")).toBe(true);
    expect(isGatePath("/preview-gate/other")).toBe(false);
    expect(isGatePath("/")).toBe(false);
  });
});

describe("gate cookie", () => {
  it("verifies a freshly signed value", () => {
    expect(verifyGateCookie(KEY, signGateCookie(KEY, NOW), NOW)).toBe(true);
  });

  it("still verifies just before expiry", () => {
    const value = signGateCookie(KEY, NOW);
    expect(verifyGateCookie(KEY, value, NOW + GATE_MAX_AGE - 1)).toBe(true);
  });

  it("rejects a tampered MAC", () => {
    const [exp, mac] = signGateCookie(KEY, NOW).split(".");
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    expect(verifyGateCookie(KEY, `${exp}.${flipped}`, NOW)).toBe(false);
  });

  it("rejects a tampered exp", () => {
    const [exp, mac] = signGateCookie(KEY, NOW).split(".");
    expect(verifyGateCookie(KEY, `${Number(exp) + 1}.${mac}`, NOW)).toBe(false);
  });

  it("rejects an expired value", () => {
    const value = signGateCookie(KEY, NOW);
    expect(verifyGateCookie(KEY, value, NOW + GATE_MAX_AGE)).toBe(false);
  });

  it("rejects an exp beyond 7 days plus skew, even when correctly signed", () => {
    const exp = NOW + GATE_MAX_AGE + 3600;
    const forged = signGateCookie(KEY, exp - GATE_MAX_AGE);
    expect(verifyGateCookie(KEY, forged, NOW)).toBe(false);
  });

  it("rejects a different password", () => {
    const other = deriveGateKey(SECRET, "q".repeat(16));
    expect(verifyGateCookie(other, signGateCookie(KEY, NOW), NOW)).toBe(false);
  });

  it("rejects a different secret", () => {
    const other = deriveGateKey("t".repeat(32), PASSWORD);
    expect(verifyGateCookie(other, signGateCookie(KEY, NOW), NOW)).toBe(false);
  });

  it.each(["", "a", "1.2.3", "abc.def", "0.abc", "-5.abc"])(
    "rejects malformed value %j",
    (value) => {
      expect(verifyGateCookie(KEY, value, NOW)).toBe(false);
    },
  );

  it("rejects a missing value", () => {
    expect(verifyGateCookie(KEY, undefined, NOW)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("accepts an equal password", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
  });

  it("rejects a different password", () => {
    expect(passwordMatches("x".repeat(16), PASSWORD)).toBe(false);
  });

  it("rejects a different-length password", () => {
    expect(passwordMatches("short", PASSWORD)).toBe(false);
    expect(passwordMatches(PASSWORD + "x", PASSWORD)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps a same-site path with a query", () => {
    expect(safeNextPath("/x?y=1")).toBe("/x?y=1");
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "/preview-gate",
    "/preview-gate?next=/x",
    "/preview-gate/unlock",
    "/a\nb",
    `/${"a".repeat(3000)}`,
    "",
  ])("falls back to / for %j", (raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("falls back to / for null and undefined", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});

describe("createAttemptLimiter", () => {
  const options = { limit: 10, windowMs: 15 * 60_000, maxKeys: 3 };

  it("refuses the 11th hit inside the window", () => {
    const limiter = createAttemptLimiter(options);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.hit("a", 0).allowed).toBe(true);
    }
    const refused = limiter.hit("a", 1000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows a hit after the window", () => {
    const limiter = createAttemptLimiter(options);
    for (let i = 0; i < 11; i += 1) limiter.hit("a", 0);
    expect(limiter.hit("a", options.windowMs + 1).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = createAttemptLimiter(options);
    for (let i = 0; i < 11; i += 1) limiter.hit("a", 0);
    expect(limiter.hit("b", 0).allowed).toBe(true);
  });

  it("never holds more than maxKeys keys", () => {
    const limiter = createAttemptLimiter(options);
    for (let i = 0; i < 11; i += 1) limiter.hit("a", 0);
    limiter.hit("b", 0);
    limiter.hit("c", 0);
    limiter.hit("d", 0);
    // "a" was the oldest and was dropped, so its count starts over.
    expect(limiter.hit("a", 0).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded hop", () => {
    const headers = new Headers({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" });
    expect(clientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to unknown", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
