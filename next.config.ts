import type { NextConfig } from "next";
// Relative on purpose: the `@/` alias is not resolved for this file.
import { securityHeaders } from "./src/lib/security/headers";

// Build tooling, like prisma.config.ts, not application code: it runs before
// src/lib/env.ts can, so it reads SGAUTH_ENV directly (docs/ENGINEERING.md
// section 2 covers application code only). An unset value fails safe to noindex.
const isProduction = process.env.SGAUTH_ENV === "production";

const nextConfig: NextConfig = {
  // Next 16 dev blocks HMR and dev assets for any origin but localhost.
  allowedDevOrigins: ["*.sga.localhost"],
  // Supabase is pointed at the issuer URL, so discovery and the key set must
  // resolve under /.well-known. The preview gate exempts the original paths.
  async rewrites() {
    return [
      { source: "/.well-known/jwks.json", destination: "/api/auth/jwks" },
      {
        source: "/.well-known/openid-configuration",
        destination: "/api/sgauth/openid-configuration",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          ...(isProduction
            ? []
            : [{ key: "X-Robots-Tag", value: "noindex, nofollow" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
