import { describe, expect, it } from "vitest";
import { symmetricEncrypt } from "better-auth/crypto";
import {
  JWKS_GRACE_PERIOD_SECONDS,
  STAGED_KEY_CREATED_AT,
} from "../../src/lib/auth/jwt-constants";
import {
  JwksRotationError,
  classifyKeys,
  describeCipher,
  formatKeyStatus,
  planActivate,
  planRetire,
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

describe("planActivate with published ids", () => {
  const keys = classifyKeys(
    [row("a"), row("s", { createdAt: STAGED_KEY_CREATED_AT })],
    NOW,
  );

  it("passes when the staged key is served", () => {
    expect(planActivate(keys, new Set(["a", "s"]))).toEqual({
      activeId: "a",
      stagedId: "s",
    });
  });

  it("refuses when the staged key is not served yet", () => {
    expect(() => planActivate(keys, new Set(["a"]))).toThrow(
      /not in the public JWKS/,
    );
  });
});

describe("planRetire", () => {
  const retired = row("old", {
    createdAt: new Date(NOW.getTime() - 90 * DAY_MS),
    expiresAt: new Date(NOW.getTime() - GRACE_MS),
  });

  it("names a key past its grace period", () => {
    const keys = classifyKeys([row("a"), retired], NOW);
    expect(planRetire(keys, "old")).toEqual({ retireId: "old" });
  });

  it("refuses an unknown key", () => {
    expect(() => planRetire(classifyKeys([row("a")], NOW), "nope")).toThrow(
      /no key nope/,
    );
  });

  it("refuses the active key", () => {
    expect(() => planRetire(classifyKeys([row("a")], NOW), "a")).toThrow(
      /is active, not retired/,
    );
  });

  it("refuses a staged key", () => {
    const keys = classifyKeys(
      [row("a"), row("s", { createdAt: STAGED_KEY_CREATED_AT })],
      NOW,
    );
    expect(() => planRetire(keys, "s")).toThrow(/is staged, not retired/);
  });

  it("refuses a key still inside its grace period", () => {
    const retiring = row("r", {
      expiresAt: new Date(NOW.getTime() - GRACE_MS + 1),
    });
    const keys = classifyKeys([row("a"), retiring], NOW);
    expect(() => planRetire(keys, "r")).toThrow(/is retiring, not retired/);
  });

  it("refuses when no active signer would remain", () => {
    expect(() => planRetire(classifyKeys([retired], NOW), "old")).toThrow(
      /no active signing key/,
    );
  });
});

describe("describeCipher", () => {
  const SECRET = "s".repeat(32);
  const OTHER = "t".repeat(32);

  const config = (secret: string, version: number) => ({
    keys: new Map([[version, secret]]),
    currentVersion: version,
    legacySecret: SECRET,
  });

  it("reads a versioned envelope and a matching secret", async () => {
    const stored = JSON.stringify(
      await symmetricEncrypt({ key: config(OTHER, 2), data: "{}" }),
    );
    expect(await describeCipher(stored, config(OTHER, 2))).toEqual({
      cipher: "v2",
      decrypts: true,
    });
  });

  it("reports a bare ciphertext as legacy and opens it with the legacy secret", async () => {
    const stored = JSON.stringify(
      await symmetricEncrypt({ key: SECRET, data: "{}" }),
    );
    expect(await describeCipher(stored, config(OTHER, 2))).toEqual({
      cipher: "legacy",
      decrypts: true,
    });
  });

  it("reports decrypts=no for the wrong secret, without throwing", async () => {
    const stored = JSON.stringify(
      await symmetricEncrypt({ key: SECRET, data: "{}" }),
    );
    expect(await describeCipher(stored, OTHER)).toEqual({
      cipher: "legacy",
      decrypts: false,
    });
  });
});

describe("formatKeyStatus", () => {
  it("adds the cipher and decrypt result when known, never key material", () => {
    const keys = classifyKeys([row("a")], NOW);
    const text = formatKeyStatus(
      keys,
      new Map([["a", { cipher: "v2", decrypts: true }]]),
    );
    expect(text).toContain("cipher=v2  decrypts=yes");
  });

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
