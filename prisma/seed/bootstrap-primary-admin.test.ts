import { describe, expect, it } from "vitest";
import {
  BootstrapRefusedError,
  formatBootstrapSummary,
  parseBootstrapArgs,
  planBootstrap,
  type BootstrapState,
} from "./bootstrap-primary-admin";
import { UsageError } from "./sync-env";

const EMAIL = "pa@northeastern.edu";

function state(overrides: Partial<BootstrapState> = {}): BootstrapState {
  return {
    primaryAdminCount: 0,
    target: {
      id: "user-1",
      isAdmin: false,
      isPrimaryAdmin: false,
      emailVerified: true,
      status: "ACTIVE",
    },
    hasCredential: true,
    sessionCount: 0,
    ...overrides,
  };
}

describe("parseBootstrapArgs", () => {
  it("lowercases and trims the email, and defaults to a dry run", () => {
    expect(parseBootstrapArgs(["--email", "  PA@Northeastern.EDU "])).toEqual({
      email: EMAIL,
      apply: false,
    });
  });

  it("accepts --apply in either position", () => {
    expect(parseBootstrapArgs(["--apply", "--email", EMAIL]).apply).toBe(true);
    expect(parseBootstrapArgs(["--email", EMAIL, "--apply"]).apply).toBe(true);
  });

  it.each([
    ["no arguments", []],
    ["a missing --email", ["--apply"]],
    ["an --email with no value", ["--email"]],
    ["an --email followed by a flag", ["--email", "--apply"]],
    ["an invalid email", ["--email", "not-an-email"]],
    ["a repeated --email", ["--email", EMAIL, "--email", EMAIL]],
    ["a repeated --apply", ["--email", EMAIL, "--apply", "--apply"]],
    ["an unknown flag", ["--email", EMAIL, "--bogus"]],
    ["a stray positional", ["--email", EMAIL, "extra"]],
  ])("throws a UsageError for %s", (_label, argv) => {
    expect(() => parseBootstrapArgs(argv)).toThrow(UsageError);
  });
});

describe("planBootstrap", () => {
  it("plans the promotion with the target's session count", () => {
    expect(planBootstrap(state({ sessionCount: 3 }), EMAIL)).toEqual({
      userId: "user-1",
      sessionsToRevoke: 3,
    });
  });

  it("refuses first when a Primary Admin exists, even for an otherwise valid target", () => {
    expect(() => planBootstrap(state({ primaryAdminCount: 1 }), EMAIL)).toThrow(
      /a Primary Admin already exists/,
    );
  });

  it("puts the Primary Admin refusal ahead of every other refusal", () => {
    const worst = state({
      primaryAdminCount: 1,
      target: null,
      hasCredential: false,
    });
    expect(() => planBootstrap(worst, EMAIL)).toThrow(
      /a Primary Admin already exists/,
    );
  });

  it("refuses an unknown account, naming the address", () => {
    expect(() =>
      planBootstrap(state({ target: null, hasCredential: false }), EMAIL),
    ).toThrow(`No account for ${EMAIL}.`);
  });

  it("refuses an inactive account before an unverified one", () => {
    const target = {
      id: "user-1",
      isAdmin: false,
      isPrimaryAdmin: false,
      emailVerified: false,
      status: "DEACTIVATED",
    };
    expect(() =>
      planBootstrap(state({ target, hasCredential: false }), EMAIL),
    ).toThrow(`${EMAIL} is DEACTIVATED.`);
  });

  it("refuses an unverified email before a missing password", () => {
    const target = {
      id: "user-1",
      isAdmin: false,
      isPrimaryAdmin: false,
      emailVerified: false,
      status: "ACTIVE",
    };
    expect(() =>
      planBootstrap(state({ target, hasCredential: false }), EMAIL),
    ).toThrow(`${EMAIL} has not verified its email address.`);
  });

  it("refuses an account with no password", () => {
    expect(() => planBootstrap(state({ hasCredential: false }), EMAIL)).toThrow(
      `${EMAIL} has no password set.`,
    );
  });

  it("throws BootstrapRefusedError", () => {
    expect(() => planBootstrap(state({ target: null }), EMAIL)).toThrow(
      BootstrapRefusedError,
    );
  });
});

describe("formatBootstrapSummary", () => {
  it("lists the grant, the revocation and the audit row", () => {
    expect(
      formatBootstrapSummary(EMAIL, { userId: "user-1", sessionsToRevoke: 2 }),
    ).toBe(
      [
        `~ grant admin and Primary Admin to ${EMAIL}`,
        `- revoke 2 session(s) for ${EMAIL}`,
        "+ audit PA_BOOTSTRAPPED",
      ].join("\n"),
    );
  });

  it("omits the revoke line at zero sessions", () => {
    expect(
      formatBootstrapSummary(EMAIL, { userId: "user-1", sessionsToRevoke: 0 }),
    ).toBe(
      [
        `~ grant admin and Primary Admin to ${EMAIL}`,
        "+ audit PA_BOOTSTRAPPED",
      ].join("\n"),
    );
  });
});
