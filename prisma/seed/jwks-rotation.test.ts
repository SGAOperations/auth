import { describe, expect, it } from "vitest";
import {
  JWKS_GRACE_PERIOD_SECONDS,
  STAGED_KEY_CREATED_AT,
} from "../../src/lib/auth/jwt-constants";
import {
  JwksRotationError,
  classifyKeys,
  formatKeyStatus,
  planActivate,
  planStage,
  type KeyRow,
} from "./jwks-rotation";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = JWKS_GRACE_PERIOD_SECONDS * 1000;

const row = (id: string, overrides: Partial<KeyRow> = {}): KeyRow => ({
  id,
  alg: "ES256",
  createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
  expiresAt: null,
  ...overrides,
});

const stateOf = (rows: KeyRow[], id: string) =>
  classifyKeys(rows, NOW).find((key) => key.row.id === id)?.state;

describe("classifyKeys", () => {
  it("marks the newest live ES256 key active", () => {
    const older = row("older", {
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const newer = row("newer");
    expect(stateOf([older, newer], "newer")).toBe("active");
    expect(stateOf([older, newer], "older")).toBe("superseded");
  });

  it("marks a sentinel-dated live key staged, never active", () => {
    const active = row("active");
    const staged = row("staged", { createdAt: STAGED_KEY_CREATED_AT });
    expect(stateOf([active, staged], "staged")).toBe("staged");
    expect(stateOf([active, staged], "active")).toBe("active");
  });

  it("marks an expired key retiring until the grace period ends", () => {
    const expiresAt = new Date(NOW.getTime() - GRACE_MS + 1);
    expect(stateOf([row("old", { expiresAt })], "old")).toBe("retiring");
  });

  it("retires a key exactly 7 days after it expired", () => {
    const expiresAt = new Date(NOW.getTime() - GRACE_MS);
    expect(stateOf([row("old", { expiresAt })], "old")).toBe("retired");
  });

  it("treats a key expiring exactly now as retiring, not live", () => {
    expect(stateOf([row("old", { expiresAt: NOW })], "old")).toBe("retiring");
  });

  it("reports other algorithms and legacy rows as other", () => {
    const rows = [row("eddsa", { alg: "EdDSA" }), row("legacy", { alg: null })];
    expect(stateOf(rows, "eddsa")).toBe("other");
    expect(stateOf(rows, "legacy")).toBe("other");
  });

  it("lists the newest key first", () => {
    const keys = classifyKeys(
      [
        row("a", { createdAt: new Date(NOW.getTime() - 3 * DAY_MS) }),
        row("b", { createdAt: new Date(NOW.getTime() - 1 * DAY_MS) }),
      ],
      NOW,
    );
    expect(keys.map((key) => key.row.id)).toEqual(["b", "a"]);
  });
});

describe("planStage", () => {
  it("passes with one active key", () => {
    expect(() => planStage(classifyKeys([row("a")], NOW))).not.toThrow();
  });

  it("refuses when a staged key already exists", () => {
    const keys = classifyKeys(
      [row("a"), row("s", { createdAt: STAGED_KEY_CREATED_AT })],
      NOW,
    );
    expect(() => planStage(keys)).toThrow(JwksRotationError);
    expect(() => planStage(keys)).toThrow(/staged key already exists/);
  });

  it("refuses when there is no active key", () => {
    expect(() => planStage(classifyKeys([], NOW))).toThrow(/\/api\/auth\/jwks/);
  });
});

describe("planActivate", () => {
  it("names the key to expire and the key to promote", () => {
    const keys = classifyKeys(
      [row("a"), row("s", { createdAt: STAGED_KEY_CREATED_AT })],
      NOW,
    );
    expect(planActivate(keys)).toEqual({ activeId: "a", stagedId: "s" });
  });

  it("refuses with nothing staged", () => {
    expect(() => planActivate(classifyKeys([row("a")], NOW))).toThrow(
      JwksRotationError,
    );
  });

  it("refuses with two staged keys", () => {
    const staged = { createdAt: STAGED_KEY_CREATED_AT };
    const keys = classifyKeys(
      [row("a"), row("s1", staged), row("s2", staged)],
      NOW,
    );
    expect(() => planActivate(keys)).toThrow(/More than one staged key/);
  });
});

describe("formatKeyStatus", () => {
  it("prints ids, states and dates, never key material", () => {
    const keys = classifyKeys(
      [
        {
          ...row("a"),
          // Not part of KeyRow; proves extra columns are never printed.
          privateKey: "SECRET-PRIVATE",
          publicKey: "PUBLIC",
        } as KeyRow,
        row("s", { createdAt: STAGED_KEY_CREATED_AT }),
      ],
      NOW,
    );
    const text = formatKeyStatus(keys);
    expect(text).toContain("a  active");
    expect(text).toContain("s  staged");
    expect(text).not.toContain("SECRET-PRIVATE");
    expect(text).not.toContain("PUBLIC");
  });

  it("explains an empty key set", () => {
    expect(formatKeyStatus([])).toMatch(/No signing keys/);
  });
});
