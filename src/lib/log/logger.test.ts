import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "@/lib/log/context";
import { createLogger, resolveLogLevel } from "@/lib/log/logger";
import { logLineSchema, type LogLevel } from "@/lib/log/schema";

function capture(level: Parameters<typeof createLogger>[0]["level"]) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = createLogger({
    level,
    env: "production",
    write: (line, lineLevel) => lines.push({ line, level: lineLevel }),
  });
  return { lines, logger };
}

describe("resolveLogLevel", () => {
  it.each([
    ["production", "info"],
    ["dev", "info"],
    ["preview", "debug"],
    ["local", "debug"],
  ] as const)("defaults %s to %s", (SGAUTH_ENV, expected) => {
    expect(resolveLogLevel({ SGAUTH_ENV })).toBe(expected);
  });

  it("lets an explicit LOG_LEVEL win", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn", SGAUTH_ENV: "local" })).toBe(
      "warn",
    );
    expect(resolveLogLevel({ LOG_LEVEL: "silent" })).toBe("silent");
  });

  it("falls back to info with nothing set, without throwing", () => {
    expect(resolveLogLevel({})).toBe("info");
  });
});

describe("createLogger", () => {
  it("drops lines below the level", () => {
    const { lines, logger } = capture("info");
    logger.debug("quiet");
    logger.info("loud");
    expect(lines.map((entry) => entry.level)).toEqual(["info"]);
  });

  it("writes nothing at silent", () => {
    const { lines, logger } = capture("silent");
    logger.error("never");
    expect(lines).toEqual([]);
  });

  it("promotes request fields and puts the rest under data", () => {
    const { lines, logger } = capture("info");
    logger.info("done", {
      status: 200,
      latencyMs: 3,
      outcome: "success",
      x: 1,
    });
    expect(JSON.parse(lines[0].line)).toMatchObject({
      status: 200,
      latencyMs: 3,
      outcome: "success",
      data: { x: 1 },
    });
  });

  it("lets request identity win over caller fields", () => {
    const { lines, logger } = capture("info");
    runWithRequestContext(
      { requestId: "real", route: "/r", method: "GET", path: "/p" },
      () => logger.info("x", { requestId: "forged" }),
    );
    const parsed = JSON.parse(lines[0].line);
    expect(parsed.requestId).toBe("real");
    expect(parsed.data).toEqual({ requestId: "forged" });
  });

  it("serializes cyclic and bigint fields instead of throwing", () => {
    const { lines, logger } = capture("info");
    const cyclic: Record<string, unknown> = { big: BigInt(1) };
    cyclic.self = cyclic;
    logger.info("x", { cyclic });
    expect(JSON.parse(lines[0].line)).toMatchObject({
      data: { cyclic: { big: "1", self: "[Circular]" } },
    });
  });

  it("writes a minimal line instead of throwing on a throwing getter", () => {
    const { lines, logger } = capture("info");
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(() => logger.info("x", { hostile })).not.toThrow();
    expect(() => logger.info("y", hostile)).not.toThrow();
    expect(lines).toHaveLength(2);
    for (const { line, level } of lines) {
      expect(level).toBe("info");
      expect(JSON.parse(line)).toMatchObject({
        level: "error",
        msg: "log serialization failed",
        service: "sgauth",
        env: "production",
      });
    }
  });

  it("validates a production sample line and keeps secrets out of it", () => {
    const { lines, logger } = capture("info");
    const userId = "0192f0c1-7a5e-7c3b-8f2d-1a2b3c4d5e6f";

    runWithRequestContext(
      {
        requestId: "iad1::abc-123",
        route: "/api/auth/[...all]",
        method: "POST",
        path: "/api/auth/sign-in/email",
        userId,
      },
      () =>
        logger.info("sign-in", {
          email: "x@northeastern.edu",
          password: "PW_SENTINEL_1",
          headers: {
            cookie: "__Secure-better-auth.session_token=COOKIE_SENTINEL_2",
            authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.SIG_SENTINEL_3",
          },
          token: "TOKEN_SENTINEL_4",
        }),
    );

    const { line } = lines[0];
    const parsed: unknown = JSON.parse(line);
    expect(() => logLineSchema.parse(parsed)).not.toThrow();
    for (const secret of [
      "x@northeastern.edu",
      "PW_SENTINEL_1",
      "COOKIE_SENTINEL_2",
      "SIG_SENTINEL_3",
      "TOKEN_SENTINEL_4",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(parsed).toMatchObject({ requestId: "iad1::abc-123", userId });
    expect(parsed).not.toHaveProperty("email");
  });

  it("rejects a top-level email field in the schema", () => {
    const { lines, logger } = capture("info");
    logger.info("x");
    const withEmail = { ...JSON.parse(lines[0].line), email: "a@b.co" };
    expect(logLineSchema.safeParse(withEmail).success).toBe(false);
  });
});
