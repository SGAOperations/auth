import type { NextConfig } from "next";

// Build tooling, like prisma.config.ts, not application code: it runs before
// src/lib/env.ts can, so it reads SGAUTH_ENV directly (docs/ENGINEERING.md
// section 2 covers application code only). An unset value fails safe to noindex.
const isProduction = process.env.SGAUTH_ENV === "production";

const nextConfig: NextConfig = {
  // Next 16 dev blocks HMR and dev assets for any origin but localhost.
  allowedDevOrigins: ["*.sga.localhost"],
  async headers() {
    if (isProduction) return [];
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
