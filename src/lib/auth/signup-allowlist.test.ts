import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  isEmailAllowed,
  parseSignupAllowlist,
} from "@/lib/auth/signup-allowlist";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";

describe("parseSignupAllowlist", () => {
  it("treats unset and empty as an empty list", () => {
    for (const raw of [undefined, "", " , ,"]) {
      const list = parseSignupAllowlist(raw);
      expect(list.emails.size).toBe(0);
      expect(list.domains.size).toBe(0);
    }
  });

  it("splits emails and domains, trimming and lowercasing", () => {
    const list = parseSignupAllowlist(" A@B.com , @Northeastern.edu ,");
    expect([...list.emails]).toEqual(["a@b.com"]);
    expect([...list.domains]).toEqual(["northeastern.edu"]);
  });

  it.each(["not-an-email", "@", "@nodot", "a@@b.com", "a@b@c.com", "@a@b.com"])(
    "rejects malformed entry %j by position without echoing it",
    (entry) => {
      let message = "";
      try {
        parseSignupAllowlist(`ok@example.com,${entry}`);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("SGAUTH_SIGNUP_ALLOWLIST: invalid entry #1");
    },
  );
});

describe("isEmailAllowed", () => {
  const list = parseSignupAllowlist("Person@Example.com,@northeastern.edu");

  it("matches an exact email regardless of case and whitespace", () => {
    expect(isEmailAllowed(list, "  PERSON@example.COM ")).toBe(true);
  });

  it("matches a domain entry exactly", () => {
    expect(isEmailAllowed(list, "a@northeastern.edu")).toBe(true);
  });

  it("does not match subdomains or look-alike hosts", () => {
    expect(isEmailAllowed(list, "a@sub.northeastern.edu")).toBe(false);
    expect(isEmailAllowed(list, "a@northeastern.edu.evil.com")).toBe(false);
  });

  it("uses the last @ for the domain", () => {
    expect(isEmailAllowed(list, "a@b@northeastern.edu")).toBe(true);
    expect(isEmailAllowed(list, "a@northeastern.edu@evil.com")).toBe(false);
  });

  it("allows nobody from an empty list", () => {
    expect(isEmailAllowed(parseSignupAllowlist(""), "a@northeastern.edu")).toBe(
      false,
    );
  });

  it("rejects a string with no @", () => {
    expect(isEmailAllowed(list, "northeastern.edu")).toBe(false);
  });
});

function makeAuth(withPlugin: boolean) {
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "s".repeat(32),
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: withPlugin
      ? [signupAllowlist(parseSignupAllowlist("@example.edu"))]
      : [],
  });
}

function signUp(auth: ReturnType<typeof makeAuth>, email: string) {
  return auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "Test" },
  });
}

describe("signupAllowlist plugin", () => {
  it("refuses a non-allowlisted email with the invite-only message", async () => {
    await expect(signUp(makeAuth(true), "a@other.com")).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: "Sign-up is invite-only on this environment." },
    });
  });

  it("allows an allowlisted email", async () => {
    const result = await signUp(makeAuth(true), "a@example.edu");
    expect(result.user.email).toBe("a@example.edu");
  });

  it("allows any email when the plugin is not registered", async () => {
    const result = await signUp(makeAuth(false), "a@other.com");
    expect(result.user.email).toBe("a@other.com");
  });
});
