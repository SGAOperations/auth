import { describe, expect, it } from "vitest";
import {
  minimalSessionResponseSchema,
  sessionResponseSchema,
} from "@/lib/sgauth-session/contract";
import {
  pickSessionCookies,
  sessionTokenValue,
  sortPositions,
  toMinimalResponse,
  toSessionResponse,
  type SessionSubject,
} from "@/lib/sgauth-session/mapping";

const TOKEN = "__Secure-sgauth.session_token";
const DONT_REMEMBER = "__Secure-sgauth.dont_remember";
const NAMES = [TOKEN, DONT_REMEMBER] as const;

describe("pickSessionCookies", () => {
  it("keeps both SGAuth cookies and drops foreign ones", () => {
    expect(
      pickSessionCookies(
        `theme=dark; ${TOKEN}=abc; _ga=1; ${DONT_REMEMBER}=true`,
        NAMES,
      ),
    ).toBe(`${TOKEN}=abc; ${DONT_REMEMBER}=true`);
  });

  it("keeps duplicate session cookies in their original order", () => {
    expect(
      pickSessionCookies(`${TOKEN}=first; x=1; ${TOKEN}=second`, NAMES),
    ).toBe(`${TOKEN}=first; ${TOKEN}=second`);
  });

  it("keeps a value that contains an equals sign", () => {
    expect(pickSessionCookies(`${TOKEN}=a.b%3D`, NAMES)).toBe(
      `${TOKEN}=a.b%3D`,
    );
  });

  it.each([
    ["only dont_remember", `${DONT_REMEMBER}=true`],
    ["only foreign cookies", "a=1; b=2"],
    ["a lookalike name", `x${TOKEN}=abc`],
    ["an empty header", ""],
    ["no header", null],
  ])("returns null for %s", (_label, header) => {
    expect(pickSessionCookies(header, NAMES)).toBeNull();
  });
});

describe("sessionTokenValue", () => {
  it("returns the first token value", () => {
    expect(
      sessionTokenValue(`${DONT_REMEMBER}=true; ${TOKEN}=abc=`, TOKEN),
    ).toBe("abc=");
  });

  it("returns null without the token", () => {
    expect(sessionTokenValue(`${DONT_REMEMBER}=true`, TOKEN)).toBeNull();
  });
});

describe("sortPositions", () => {
  it("orders by code unit, not by collation", () => {
    const input = ["vpa", "vp-finance", "a-1", "a"].map((key) => ({
      key,
      name: key,
    }));
    expect(sortPositions(input).map((p) => p.key)).toEqual([
      "a",
      "a-1",
      "vp-finance",
      "vpa",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [{ key: "b" }, { key: "a" }];
    sortPositions(input);
    expect(input.map((p) => p.key)).toEqual(["b", "a"]);
  });
});

const subject: SessionSubject = {
  id: "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  email: "sam@northeastern.edu",
  name: "Sam Example",
  preferredName: "Sam",
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  positions: [{ key: "vp-finance", name: "Vice President of Finance" }],
};

const session = {
  id: "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-31T00:00:00Z"),
  absoluteExpiresAt: new Date("2026-04-01T00:00:00Z"),
};

describe("toSessionResponse", () => {
  it("maps dates to ISO strings and passes the strict schema", () => {
    const body = toSessionResponse({ subject, session });
    expect(body.session).toEqual({
      id: session.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
      absoluteExpiresAt: "2026-04-01T00:00:00.000Z",
    });
    expect(sessionResponseSchema.safeParse(body).success).toBe(true);
  });

  it("never copies the subject status", () => {
    expect(
      JSON.stringify(toSessionResponse({ subject, session })),
    ).not.toContain("status");
  });

  it("throws when absoluteExpiresAt is missing", () => {
    expect(() =>
      toSessionResponse({
        subject,
        session: { ...session, absoluteExpiresAt: undefined },
      }),
    ).toThrow(/absoluteExpiresAt/);
    expect(() =>
      toSessionResponse({
        subject,
        session: { ...session, absoluteExpiresAt: null },
      }),
    ).toThrow(/absoluteExpiresAt/);
  });
});

describe("toMinimalResponse", () => {
  it("returns only the user id and positions", () => {
    const body = toMinimalResponse({ subject });
    expect(body).toEqual({
      user: { id: subject.id },
      positions: subject.positions,
    });
    expect(minimalSessionResponseSchema.safeParse(body).success).toBe(true);
  });
});
