import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  buildCapture,
  type AnalyticsEventName,
} from "@/lib/analytics/events";

const USER_ID = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const BASE = { sgauth_env: "dev", request_id: "req-1" };

const VALID_PROPERTIES: Record<AnalyticsEventName, object> = {
  login_succeeded: { method: "password" },
  login_failed: { reason: "INVALID_EMAIL_OR_PASSWORD" },
  signup_started: {},
  signup_completed: {},
  reset_requested: {},
  reset_completed: {},
  mfa_enrolled: {},
  account_locked: {},
  session_endpoint_error: { status: 503, kind: "server_error" },
};

const names = Object.keys(ANALYTICS_EVENTS) as AnalyticsEventName[];

describe("ANALYTICS_EVENTS", () => {
  it.each(names)("%s accepts its own properties", (name) => {
    expect(
      ANALYTICS_EVENTS[name].safeParse(VALID_PROPERTIES[name]).success,
    ).toBe(true);
  });

  it.each(names)("%s rejects an extra key", (name) => {
    const result = ANALYTICS_EVENTS[name].safeParse({
      ...VALID_PROPERTIES[name],
      extra: "x",
    });
    expect(result.success).toBe(false);
  });

  it("login_failed accepts only the audit reasons", () => {
    const schema = ANALYTICS_EVENTS.login_failed;
    for (const reason of [
      "INVALID_EMAIL_OR_PASSWORD",
      "EMAIL_NOT_VERIFIED",
      "ACCOUNT_DEACTIVATED",
      "OTHER",
    ]) {
      expect(schema.safeParse({ reason }).success).toBe(true);
    }
    expect(schema.safeParse({ reason: "someone@example.edu" }).success).toBe(
      false,
    );
  });

  it("session_endpoint_error accepts a null status and rejects non-5xx", () => {
    const schema = ANALYTICS_EVENTS.session_endpoint_error;
    expect(schema.safeParse({ status: null, kind: "exception" }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ status: 404, kind: "server_error" }).success,
    ).toBe(false);
  });
});

describe("buildCapture", () => {
  it("identifies a known user by id and merges the base after validation", () => {
    const message = buildCapture(
      "login_succeeded",
      { userId: USER_ID, properties: { method: "password" } },
      BASE,
    );
    expect(message).toEqual({
      distinctId: USER_ID,
      event: "login_succeeded",
      properties: {
        method: "password",
        sgauth_env: "dev",
        request_id: "req-1",
      },
    });
  });

  it("uses a random UUID and no person profile when anonymous", () => {
    const message = buildCapture(
      "login_failed",
      { properties: { reason: "OTHER" } },
      BASE,
    );
    expect(message?.distinctId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(message?.properties.$process_person_profile).toBe(false);
  });

  it("omits request_id when the base has none", () => {
    const message = buildCapture(
      "signup_started",
      { userId: USER_ID, properties: {} },
      { sgauth_env: "local" },
    );
    expect(message?.properties).toEqual({ sgauth_env: "local" });
  });

  it("returns null for a user id that is not a UUID", () => {
    expect(
      buildCapture(
        "signup_started",
        { userId: "someone@example.edu", properties: {} },
        BASE,
      ),
    ).toBeNull();
  });

  it("returns null when the properties fail the schema", () => {
    expect(
      buildCapture(
        "login_failed",
        // @ts-expect-error deliberately outside the catalog
        { properties: { reason: "NOPE" } },
        BASE,
      ),
    ).toBeNull();
  });

  it("drops an event carrying an email property and never leaks an @", () => {
    expect(
      buildCapture(
        "login_failed",
        {
          // @ts-expect-error deliberately outside the catalog
          properties: { reason: "OTHER", email: "x@northeastern.edu" },
        },
        BASE,
      ),
    ).toBeNull();

    for (const name of names) {
      const message = buildCapture(
        name,
        { userId: USER_ID, properties: VALID_PROPERTIES[name] as never },
        BASE,
      );
      expect(JSON.stringify(message)).not.toContain("@");
    }
  });
});
