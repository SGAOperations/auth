import { z } from "zod";

export interface CspViolation {
  documentUrl?: string;
  blockedUrl?: string;
  effectiveDirective: string;
  disposition?: string;
  sourceFile?: string;
  lineNumber?: number;
}

const legacyBody = z.object({
  "document-uri": z.string().optional(),
  "blocked-uri": z.string().optional(),
  "effective-directive": z.string().optional(),
  "violated-directive": z.string().optional(),
  disposition: z.string().optional(),
  "source-file": z.string().optional(),
  "line-number": z.number().optional(),
});

const legacyReport = z.object({ "csp-report": legacyBody });

const reportingBody = z.object({
  documentURL: z.string().optional(),
  blockedURL: z.string().optional(),
  effectiveDirective: z.string(),
  disposition: z.string().optional(),
  sourceFile: z.string().nullish(),
  lineNumber: z.number().nullish(),
});

const reportingEntry = z.object({ type: z.string(), body: z.unknown() });

const MAX_KEYWORD_LENGTH = 200;

/**
 * At most this many violations are logged per request, and each logged string
 * is cut to MAX_LOGGED_LENGTH, so one unauthenticated 16 KB body cannot write
 * hundreds of lines (BT28). A real page sends one report per violation.
 */
export const MAX_REPORTS_PER_REQUEST = 5;
export const MAX_LOGGED_LENGTH = 100;

function clip(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_LOGGED_LENGTH);
}

/**
 * Emailed-link pages carry tokens in the query, so every URL is reduced to
 * origin plus path. Non-URL keywords such as `inline` and `eval` pass through.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`;
    }
    return url.protocol;
  } catch {
    return value.split(/[?#]/)[0].slice(0, MAX_KEYWORD_LENGTH);
  }
}

function redactOptional(value: string | null | undefined) {
  return value ? clip(redactUrl(value)) : undefined;
}

function fromLegacy(body: z.infer<typeof legacyBody>): CspViolation | null {
  const effectiveDirective =
    body["effective-directive"] ?? body["violated-directive"];
  if (!effectiveDirective) return null;
  return {
    documentUrl: redactOptional(body["document-uri"]),
    blockedUrl: redactOptional(body["blocked-uri"]),
    effectiveDirective: effectiveDirective.slice(0, MAX_LOGGED_LENGTH),
    disposition: clip(body.disposition),
    sourceFile: redactOptional(body["source-file"]),
    lineNumber: body["line-number"],
  };
}

function fromReporting(body: z.infer<typeof reportingBody>): CspViolation {
  return {
    documentUrl: redactOptional(body.documentURL),
    blockedUrl: redactOptional(body.blockedURL),
    effectiveDirective: body.effectiveDirective.slice(0, MAX_LOGGED_LENGTH),
    disposition: clip(body.disposition),
    sourceFile: redactOptional(body.sourceFile),
    lineNumber: body.lineNumber ?? undefined,
  };
}

/**
 * Normalises both the legacy `application/csp-report` body and the Reporting
 * API `application/reports+json` array. Returns `null` for anything that is
 * neither; entries of a reports array that are not `csp-violation` are
 * skipped. Returns at most MAX_REPORTS_PER_REQUEST violations: the rest of the
 * array is not read.
 */
export function parseCspReports(input: unknown): CspViolation[] | null {
  if (Array.isArray(input)) {
    const violations: CspViolation[] = [];
    for (const item of input) {
      if (violations.length === MAX_REPORTS_PER_REQUEST) break;
      const entry = reportingEntry.safeParse(item);
      if (!entry.success) return null;
      if (entry.data.type !== "csp-violation") continue;
      const body = reportingBody.safeParse(entry.data.body);
      if (!body.success) return null;
      violations.push(fromReporting(body.data));
    }
    return violations;
  }

  const legacy = legacyReport.safeParse(input);
  if (!legacy.success) return null;
  const violation = fromLegacy(legacy.data["csp-report"]);
  return violation ? [violation] : null;
}
