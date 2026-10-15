import "server-only";
import { env } from "@/lib/env";
import { createLogger, resolveLogLevel } from "@/lib/log/logger";

export const logLevel = resolveLogLevel({
  LOG_LEVEL: env.LOG_LEVEL,
  SGAUTH_ENV: env.SGAUTH_ENV,
});

export const logger = createLogger({ level: logLevel, env: env.SGAUTH_ENV });

export { setRequestUserId } from "@/lib/log/context";
