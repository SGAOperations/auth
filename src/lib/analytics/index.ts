import "server-only";
import { PostHog } from "posthog-node";
import { createAnalytics } from "@/lib/analytics/analytics";
import { resolvePostHogSettings } from "@/lib/analytics/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";

const settings = resolvePostHogSettings(env);

// `enableExceptionAutocapture` stays off: it installs process-level handlers,
// and `onRequestError` is the Next-native path. Geo lookup is off with the
// client IP (see docs/POSTHOG.md).
const client = settings
  ? new PostHog(settings.key, {
      host: settings.host,
      flushAt: 1,
      flushInterval: 0,
      disableGeoip: true,
      requestTimeout: 3000,
    })
  : null;

if (!client) logger.info("analytics.disabled");

export const analytics = createAnalytics({
  client,
  env: env.SGAUTH_ENV,
  log: logger,
});
