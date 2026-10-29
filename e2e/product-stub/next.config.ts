import path from "node:path";
import type { NextConfig } from "next";

// The stub resolves next, react and the SDK from the repository's node_modules.
const repoRoot = path.resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // forbidden() lets /gated answer 403 without redirecting.
  experimental: { authInterrupts: true },
};

export default nextConfig;
