import { describe, expect, it } from "vitest";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import type { Rule } from "@/lib/rate-limit/policies";

const rule: Rule = { id: "t:ip:1m", limit: 3, windowSeconds: 60, by: "ip" };

function setup(maxKeys?: number) {
  let nowMs = 1_000_000;
  const backend = createMemoryBackend({ now: () => nowMs, maxKeys });
  return {
    backend,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("createMemoryBackend", () => {
  it("allows up to the limit and denies the next call", async () => {
    const { backend } = setup();
    for (let i = 0; i < 3; i++) {
      expect((await backend.limit("k", rule)).success).toBe(true);
    }
    expect((await backend.limit("k", rule)).success).toBe(false);
  });

  it("keeps keys independent", async () => {
    const { backend } = setup();
    for (let i = 0; i < 3; i++) await backend.limit("a", rule);
    expect((await backend.limit("b", rule)).success).toBe(true);
  });

  it("allows again once the window has passed", async () => {
    const { backend, advance } = setup();
    for (let i = 0; i < 3; i++) await backend.limit("k", rule);
    expect((await backend.limit("k", rule)).success).toBe(false);
    advance(60_001);
    expect((await backend.limit("k", rule)).success).toBe(true);
  });

  it("frees a slot as the oldest hit slides out", async () => {
    const { backend, advance } = setup();
    await backend.limit("k", rule);
    advance(30_000);
    await backend.limit("k", rule);
    await backend.limit("k", rule);
    expect((await backend.limit("k", rule)).success).toBe(false);
    advance(30_001);
    expect((await backend.limit("k", rule)).success).toBe(true);
  });

  it("reports when the window frees a slot", async () => {
    const { backend, advance } = setup();
    for (let i = 0; i < 3; i++) await backend.limit("k", rule);
    advance(10_000);
    const denied = await backend.limit("k", rule);
    expect(denied.resetMs).toBe(1_000_000 + 60_000);
  });

  it("does not extend the window on a denied call", async () => {
    const { backend, advance } = setup();
    for (let i = 0; i < 3; i++) await backend.limit("k", rule);
    advance(59_000);
    expect((await backend.limit("k", rule)).success).toBe(false);
    advance(1_001);
    expect((await backend.limit("k", rule)).success).toBe(true);
  });

  it("evicts the oldest key past maxKeys", async () => {
    const { backend } = setup(2);
    for (let i = 0; i < 3; i++) await backend.limit("old", rule);
    await backend.limit("b", rule);
    await backend.limit("c", rule);
    // "old" was evicted, so it starts a fresh window.
    expect((await backend.limit("old", rule)).success).toBe(true);
  });
});
