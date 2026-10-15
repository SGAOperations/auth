import "server-only";
import type { SgauthEnv } from "@/lib/env-schema";
import { getRequestContext } from "@/lib/log/context";
import { redact } from "@/lib/log/redact";
import type { LogEnv, LogLevel } from "@/lib/log/schema";

// Takes its configuration as arguments, so it never reads env and tests can
// build one directly. The configured instance lives in `@/lib/log`.

export type ConfiguredLogLevel = LogLevel | "silent";

export type LogFields = Record<string, unknown>;

export type Logger = Record<
  LogLevel,
  (msg: string, fields?: LogFields) => void
>;

const RANK: Record<ConfiguredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const DEFAULT_LEVEL_BY_ENV: Record<SgauthEnv, LogLevel> = {
  production: "info",
  dev: "info",
  preview: "debug",
  local: "debug",
};

// Fields the request wrapper sets that belong at the top level of a line.
const PROMOTED_KEYS = ["status", "latencyMs", "outcome"] as const;

/** An explicit `LOG_LEVEL` wins, then the `SGAUTH_ENV` default. Never throws. */
export function resolveLogLevel(config: {
  LOG_LEVEL?: ConfiguredLogLevel;
  SGAUTH_ENV?: SgauthEnv;
}): ConfiguredLogLevel {
  if (config.LOG_LEVEL) return config.LOG_LEVEL;
  return config.SGAUTH_ENV ? DEFAULT_LEVEL_BY_ENV[config.SGAUTH_ENV] : "info";
}

function writeToConsole(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

interface CreateLoggerInput {
  level: ConfiguredLogLevel;
  env: LogEnv;
  write?: (line: string, level: LogLevel) => void;
}

export function createLogger({
  level: threshold,
  env,
  write = writeToConsole,
}: CreateLoggerInput): Logger {
  function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (RANK[level] < RANK[threshold]) return;

    const { err, ...rest } = fields;
    const promoted: LogFields = {};
    for (const key of PROMOTED_KEYS) {
      if (key in rest) {
        promoted[key] = rest[key];
        delete rest[key];
      }
    }
    const hasErr = err instanceof Error;
    if (err !== undefined && !hasErr) rest.err = err;

    const context = getRequestContext();
    const line = redact({
      time: new Date().toISOString(),
      level,
      msg,
      service: "sgauth",
      env,
      ...promoted,
      ...(hasErr ? { err } : {}),
      ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
      // Last, so a caller can never override the request identity.
      ...(context ?? {}),
    });

    // `redact` leaves only JSON-safe values (cycles, bigints and functions are
    // already handled), so serialization cannot throw here.
    write(JSON.stringify(line), level);
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
