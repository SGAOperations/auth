// Imported by next.config.ts, which runs before src/lib/env.ts can: no
// `server-only`, no `@/` imports, and no env or secrets.

export interface SecurityHeader {
  key: string;
  value: string;
}

// HSTS applies only to the host that served it, so it is safe on every
// environment. `includeSubDomains` and `preload` are deliberately absent:
// they would bind every SGA subdomain at the apex and need the team to
// confirm each one is HTTPS-only first.
export const securityHeaders: SecurityHeader[] = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // publickey-credentials-get/-create keep their `self` default for passkeys.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];
