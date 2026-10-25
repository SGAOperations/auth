import { describe, expect, it } from "vitest";
import {
  BACKUP_CODE_HASH_PREFIX,
  hashBackupCode,
  hashedBackupCodeStorage,
} from "@/lib/auth/backup-codes";

const SECRET = "s".repeat(32);

describe("hashBackupCode", () => {
  it("is stable, prefixed and hex", () => {
    const hash = hashBackupCode(SECRET, "abcde-12345");
    expect(hash).toBe(hashBackupCode(SECRET, "abcde-12345"));
    expect(hash).toMatch(/^h1:[0-9a-f]{64}$/);
  });

  it("differs across secrets and codes", () => {
    expect(hashBackupCode(SECRET, "abcde-12345")).not.toBe(
      hashBackupCode("t".repeat(32), "abcde-12345"),
    );
    expect(hashBackupCode(SECRET, "abcde-12345")).not.toBe(
      hashBackupCode(SECRET, "abcde-12346"),
    );
  });

  it("trims its input", () => {
    expect(hashBackupCode(SECRET, "  abcde-12345\n")).toBe(
      hashBackupCode(SECRET, "abcde-12345"),
    );
  });
});

describe("hashedBackupCodeStorage", () => {
  const storage = hashedBackupCodeStorage(SECRET);
  const plain = ["abcde-12345", "fghij-67890"];

  it("stores only hashes, never the plaintext", async () => {
    const stored = await storage.encrypt(JSON.stringify(plain));
    const parsed: string[] = JSON.parse(stored);
    expect(parsed).toHaveLength(2);
    for (const entry of parsed) {
      expect(entry.startsWith(BACKUP_CODE_HASH_PREFIX)).toBe(true);
    }
    for (const code of plain) expect(stored).not.toContain(code);
    expect(parsed[0]).toBe(hashBackupCode(SECRET, "abcde-12345"));
  });

  it("leaves already-hashed entries alone when re-encoding", async () => {
    const once = await storage.encrypt(JSON.stringify(plain));
    expect(await storage.encrypt(once)).toBe(once);
  });

  it("decodes as the identity", async () => {
    const once = await storage.encrypt(JSON.stringify(plain));
    expect(await storage.decrypt(once)).toBe(once);
  });

  it("throws on anything that is not a string array", async () => {
    await expect(storage.encrypt(JSON.stringify({ a: 1 }))).rejects.toThrow();
    await expect(storage.encrypt(JSON.stringify([1, 2]))).rejects.toThrow();
    await expect(storage.encrypt("not json")).rejects.toThrow();
  });
});
