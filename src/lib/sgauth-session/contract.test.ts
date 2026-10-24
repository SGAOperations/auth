import { describe, expect, it } from "vitest";
import {
  SESSION_JSON_SCHEMAS,
  SESSION_RESPONSE_HEADERS,
  UNAUTHENTICATED_BODY,
  minimalSessionResponseSchema,
  sessionResponseSchema,
  unauthenticatedResponseSchema,
} from "@/lib/sgauth-session/contract";

const ID = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const ISO = "2026-01-01T00:00:00.000Z";

function validSession() {
  return {
    user: {
      id: ID,
      email: "sam@northeastern.edu",
      name: "Sam Example",
      preferredName: null,
      isAdmin: false,
      isPrimaryAdmin: false,
    },
    positions: [{ key: "vp-finance", name: "Vice President of Finance" }],
    session: {
      id: ID,
      expiresAt: ISO,
      absoluteExpiresAt: ISO,
      createdAt: ISO,
    },
  };
}

describe("session response schemas", () => {
  it("parses valid samples", () => {
    expect(sessionResponseSchema.safeParse(validSession()).success).toBe(true);
    expect(
      minimalSessionResponseSchema.safeParse({
        user: { id: ID },
        positions: [],
      }).success,
    ).toBe(true);
    expect(
      unauthenticatedResponseSchema.safeParse(UNAUTHENTICATED_BODY).success,
    ).toBe(true);
  });

  it("rejects an extra key at the top level and nested", () => {
    const top = { ...validSession(), extra: 1 };
    const user = validSession();
    Object.assign(user.user, { password: "x" });
    const session = validSession();
    Object.assign(session.session, { token: "x" });
    const position = validSession();
    Object.assign(position.positions[0], { id: "x" });

    for (const sample of [top, user, session, position]) {
      expect(sessionResponseSchema.safeParse(sample).success).toBe(false);
    }
    expect(
      minimalSessionResponseSchema.safeParse({
        user: { id: ID, email: "a@b.c" },
        positions: [],
      }).success,
    ).toBe(false);
    expect(
      unauthenticatedResponseSchema.safeParse({
        error: "unauthenticated",
        reason: "expired",
      }).success,
    ).toBe(false);
  });

  it("rejects more than 50 positions", () => {
    const sample = validSession();
    sample.positions = Array.from({ length: 51 }, (_, i) => ({
      key: `p-${i}`,
      name: "P",
    }));
    expect(sessionResponseSchema.safeParse(sample).success).toBe(false);
  });

  it("sends the headers every response must carry", () => {
    expect(SESSION_RESPONSE_HEADERS).toEqual({
      "Cache-Control": "no-store",
      Vary: "Cookie",
    });
  });
});

const FORBIDDEN_KEY = /password|token|secret|backup|hash|ip|agent/i;

function collectObjectNodes(node: unknown, found: object[] = []): object[] {
  if (Array.isArray(node)) {
    for (const item of node) collectObjectNodes(item, found);
  } else if (node && typeof node === "object") {
    if ((node as { type?: unknown }).type === "object") found.push(node);
    for (const value of Object.values(node)) collectObjectNodes(value, found);
  }
  return found;
}

describe.each(Object.entries(SESSION_JSON_SCHEMAS))(
  "published %s",
  (file, schema) => {
    it("closes every object and names no secret-like property", () => {
      const objects = collectObjectNodes(schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const node of objects) {
        const { additionalProperties, properties } = node as {
          additionalProperties?: unknown;
          properties?: Record<string, unknown>;
        };
        expect(additionalProperties).toBe(false);
        for (const name of Object.keys(properties ?? {})) {
          expect(name).not.toMatch(FORBIDDEN_KEY);
        }
      }
    });

    // Regenerate with:
    // npx vitest run src/lib/sgauth-session/contract.test.ts -u
    it("matches the committed file", async () => {
      await expect(JSON.stringify(schema, null, 2) + "\n").toMatchFileSnapshot(
        `../../../docs/api/${file}`,
      );
    });
  },
);
