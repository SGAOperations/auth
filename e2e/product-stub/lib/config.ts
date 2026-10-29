// Test tooling, not SGAuth application code: it is outside the `src/lib/env.ts`
// rule of docs/ENGINEERING.md section 2 and parses its own process.env once.
import { z } from "zod";

const schema = z.object({
  PRODUCT_ID: z.enum(["a", "b"]),
  PRODUCT_NAME: z.string().min(1),
  SGAUTH_URL: z.url(),
  SGAUTH_COOKIE_NAME: z.string().min(1),
  SGAUTH_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(1),
});

const parsed = schema.parse({
  PRODUCT_ID: process.env.PRODUCT_ID,
  PRODUCT_NAME: process.env.PRODUCT_NAME,
  SGAUTH_URL: process.env.SGAUTH_URL ?? "http://auth.sga.localhost:3000",
  SGAUTH_COOKIE_NAME:
    process.env.SGAUTH_COOKIE_NAME ?? "sgauth-local.session_token",
  SGAUTH_CACHE_TTL_SECONDS: process.env.SGAUTH_CACHE_TTL_SECONDS,
});

export const config = {
  productId: parsed.PRODUCT_ID,
  productName: parsed.PRODUCT_NAME,
  sgauthUrl: parsed.SGAUTH_URL,
  cookieName: parsed.SGAUTH_COOKIE_NAME,
  cacheTtlSeconds: parsed.SGAUTH_CACHE_TTL_SECONDS,
};

/** The position that gates /gated on every product stub. */
export const GATED_POSITION = "e2e-product-b-access";
