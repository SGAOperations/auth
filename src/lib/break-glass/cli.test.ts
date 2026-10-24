import { describe, expect, it } from "vitest";
import {
  RESET_MFA_PHRASE,
  TRANSFER_PHRASE,
  UsageError,
  parseRecoveryArgs,
  parseRecoveryEnv,
  phraseMatches,
} from "@/lib/break-glass/cli";

const base = [
  "--email",
  "New.PA@Northeastern.edu",
  "--operator",
  "Ada Lovelace",
  "--reason",
  "Primary Admin unreachable",
];

describe("parseRecoveryArgs", () => {
  it("parses a transfer and lower-cases the email", () => {
    expect(parseRecoveryArgs(base)).toEqual({
      mode: "transfer",
      email: "new.pa@northeastern.edu",
      operator: "Ada Lovelace",
      reason: "Primary Admin unreachable",
      dryRun: false,
      demotePrevious: false,
    });
  });

  it("parses the flags", () => {
    expect(
      parseRecoveryArgs([...base, "--dry-run", "--demote-previous"]),
    ).toMatchObject({ mode: "transfer", dryRun: true, demotePrevious: true });
    expect(parseRecoveryArgs([...base, "--reset-mfa"])).toMatchObject({
      mode: "reset_mfa",
    });
  });

  it("rejects --demote-previous together with --reset-mfa", () => {
    expect(() =>
      parseRecoveryArgs([...base, "--reset-mfa", "--demote-previous"]),
    ).toThrow(UsageError);
  });

  it("rejects an unknown flag and a positional argument", () => {
    expect(() => parseRecoveryArgs([...base, "--apply"])).toThrow(UsageError);
    expect(() => parseRecoveryArgs([...base, "extra"])).toThrow(UsageError);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseRecoveryArgs([...base, "--email"])).toThrow(UsageError);
  });

  it.each(["--email", "--operator", "--reason"])("requires %s", (flag) => {
    const at = base.indexOf(flag);
    const without = [...base.slice(0, at), ...base.slice(at + 2)];
    expect(() => parseRecoveryArgs(without)).toThrow(UsageError);
  });

  it("rejects an invalid email and a short reason", () => {
    expect(() =>
      parseRecoveryArgs(["--email", "nope", ...base.slice(2)]),
    ).toThrow(/--email/);
    expect(() =>
      parseRecoveryArgs([...base.slice(0, 4), "--reason", "too short"]),
    ).toThrow(/--reason/);
  });
});

describe("parseRecoveryEnv", () => {
  const env = {
    DIRECT_URL: "postgresql://migrator:s3cret@host.example/neondb",
    SGAUTH_ENV: "production",
    RESEND_API_KEY: "re_key",
    RESEND_FROM_EMAIL: "sgauth@example.com",
  };

  it("returns the email settings for a real run", () => {
    expect(parseRecoveryEnv(env, { dryRun: false })).toEqual({
      DIRECT_URL: env.DIRECT_URL,
      SGAUTH_ENV: "production",
      email: { apiKey: "re_key", from: "sgauth@example.com" },
    });
  });

  it("does not need the Resend variables on a dry run", () => {
    expect(
      parseRecoveryEnv(
        { DIRECT_URL: env.DIRECT_URL, SGAUTH_ENV: "dev" },
        { dryRun: true },
      ),
    ).toEqual({ DIRECT_URL: env.DIRECT_URL, SGAUTH_ENV: "dev", email: null });
  });

  it("refuses to run without DIRECT_URL, naming only the variable", () => {
    let error: unknown;
    try {
      parseRecoveryEnv({ ...env, DIRECT_URL: undefined }, { dryRun: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain("DIRECT_URL");
  });

  it("never echoes a value, even when the URL is malformed", () => {
    expect(() =>
      parseRecoveryEnv(
        { ...env, DIRECT_URL: "not a url s3cret" },
        {
          dryRun: false,
        },
      ),
    ).toThrow(/Problem with: DIRECT_URL$/);
    try {
      parseRecoveryEnv(
        { ...env, DIRECT_URL: "not a url s3cret" },
        {
          dryRun: false,
        },
      );
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret");
    }
  });

  it("requires SGAUTH_ENV and the Resend variables on a real run", () => {
    expect(() =>
      parseRecoveryEnv({ ...env, SGAUTH_ENV: "staging" }, { dryRun: false }),
    ).toThrow(/SGAUTH_ENV/);
    expect(() =>
      parseRecoveryEnv(
        { ...env, RESEND_API_KEY: undefined },
        { dryRun: false },
      ),
    ).toThrow(/RESEND_API_KEY/);
  });
});

describe("phraseMatches", () => {
  it("is exact and case-sensitive after trimming", () => {
    expect(phraseMatches(`  ${TRANSFER_PHRASE}\n`, TRANSFER_PHRASE)).toBe(true);
    expect(phraseMatches("transfer primary admin", TRANSFER_PHRASE)).toBe(
      false,
    );
    expect(phraseMatches("TRANSFER  PRIMARY ADMIN", TRANSFER_PHRASE)).toBe(
      false,
    );
    expect(phraseMatches(TRANSFER_PHRASE, RESET_MFA_PHRASE)).toBe(false);
    expect(phraseMatches("", TRANSFER_PHRASE)).toBe(false);
  });
});
