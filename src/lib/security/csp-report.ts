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
  return value ? redactUrl(value) : undefined;
}

function fromLegacy(body: z.infer<typeof legacyBody>): CspViolation | null {
  const effectiveDirective =
    body["effective-directive"] ?? body["violated-directive"];
  if (!effectiveDirective) return null;
  return {
    documentUrl: redactOptional(body["document-uri"]),
    blockedUrl: redactOptional(body["blocked-uri"]),
    effectiveDirective,
    disposition: body.disposition,
    sourceFile: redactOptional(body["source-file"]),
    lineNumber: body["line-number"],
  };
}

function fromReporting(body: z.infer<typeof reportingBody>): CspViolation {
  return {
    documentUrl: redactOptional(body.documentURL),
    blockedUrl: redactOptional(body.blockedURL),
    effectiveDirective: body.effectiveDirective,
    disposition: body.disposition,
    sourceFile: redactOptional(body.sourceFile),
    lineNumber: body.lineNumber ?? undefined,
  };
}

/**
 * Normalises both the legacy `application/csp-report` body and the Reporting
 * API `application/reports+json` array. Returns `null` for anything that is
 * neither; entries of a reports array that are not `csp-violation` are
 * skipped.
 */
export function parseCspReports(input: unknown): CspViolation[] | null {
  if (Array.isArray(input)) {
    const violations: CspViolation[] = [];
    for (const item of input) {
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
