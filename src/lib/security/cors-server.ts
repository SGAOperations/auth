import "server-only";
import { logger } from "@/lib/log";
import { getTrustedOrigins } from "@/lib/products";
import { createCors } from "@/lib/security/cors";

// Passing the request keeps SGAUTH_ENV=local echoing *.sga.localhost origins.
export const { withCors, preflight: corsPreflight } = createCors({
  trustedOrigins: (request) => getTrustedOrigins(request),
  log: logger,
});
