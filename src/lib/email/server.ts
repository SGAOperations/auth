import "server-only";
import { Redis } from "@upstash/redis";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import {
  createEmailCaps,
  createMemoryCapStore,
  createUpstashCapStore,
  type CapStore,
} from "@/lib/email/caps";
import { createMailer } from "@/lib/email/mailer";
import {
  createConsoleTransport,
  createResendTransport,
  discardTransport,
  type Transport,
} from "@/lib/email/transports";
import { logger } from "@/lib/log";
import { namespaceFor } from "@/lib/rate-limit/limiter";

const DEFAULT_FROM_ADDRESS = "no-reply@mail.northeasternsga.com";

function buildTransport(): Transport {
  if (env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    return createResendTransport({ apiKey: env.RESEND_API_KEY });
  }
  // The env schema requires the pair on production and dev, so this is local
  // or preview.
  if (env.SGAUTH_ENV === "local") return createConsoleTransport();
  logger.warn("Email is discarded (RESEND_* unset); sends are logged only.");
  return discardTransport;
}

function buildCapStore(): CapStore {
  // Never Redis.fromEnv(): env is read only through src/lib/env.ts.
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createUpstashCapStore({
      redis: new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }),
      prefix: namespaceFor(env.SGAUTH_ENV),
    });
  }
  return createMemoryCapStore();
}

export const mailer = createMailer({
  transport: buildTransport(),
  caps: createEmailCaps({
    store: buildCapStore(),
    dailyCap: env.SGAUTH_EMAIL_DAILY_CAP,
    log: logger,
  }),
  from: `SGA Auth <${env.RESEND_FROM_EMAIL ?? DEFAULT_FROM_ADDRESS}>`,
  linkOrigin: new URL(toAuthSettings(env).baseURL).origin,
  log: logger,
});

export const sendEmail = mailer.sendEmail;
