import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_MAX_AGE_MS,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_OPTIONS,
  SESSION_UPDATE_AGE_SECONDS,
  initialSessionWindow,
} from "@/lib/auth/session-lifetime";

const DAY_MS = 24 * 60 * 60 * 1000;
const T = new Date("2026-10-01T00:00:00.000Z");
const after = (days: number) => new Date(T.getTime() + days * DAY_MS);

describe("session lifetime constants", () => {
  it("is a 30-day sliding window refreshed daily under a 90-day cap", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(2_592_000);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(86_400);
    expect(SESSION_ABSOLUTE_MAX_AGE_MS).toBe(90 * DAY_MS);
  });

  it("disables the cookie cache and leaves freshAge at its default", () => {
    expect(SESSION_OPTIONS.cookieCache.enabled).toBe(false);
    expect(SESSION_OPTIONS).not.toHaveProperty("freshAge");
  });
});

describe("initialSessionWindow", () => {
  it("caps at createdAt plus 90 days and keeps an earlier expiry", () => {
    const window = initialSessionWindow({
      createdAt: T,
      expiresAt: after(30),
    });
    expect(window.absoluteExpiresAt).toEqual(after(90));
    expect(window.expiresAt).toEqual(after(30));
  });

  it("clamps an expiry past the cap", () => {
    const window = initialSessionWindow({
      createdAt: T,
      expiresAt: after(120),
    });
    expect(window.expiresAt).toEqual(after(90));
  });

  it("does not mutate its input", () => {
    const input = { createdAt: new Date(T), expiresAt: after(120) };
    initialSessionWindow(input);
    expect(input.createdAt).toEqual(T);
    expect(input.expiresAt).toEqual(after(120));
  });
});
