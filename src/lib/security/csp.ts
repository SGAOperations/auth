import type { CspMode } from "@/lib/env-schema";

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  reportUri: string;
}

export function buildCsp({ nonce, isDev, reportUri }: CspOptions): string {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  // React's dev tooling needs eval; production never does.
  if (isDev) scriptSrc.push(`'unsafe-eval'`);

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    // React style attributes and runtime style injection cannot carry nonces.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    // Local development runs over plain http.
    ...(isDev ? [] : [`upgrade-insecure-requests`]),
    `report-uri ${reportUri}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  return directives.join("; ");
}

export function cspHeaderName(mode: CspMode): string {
  return mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}
