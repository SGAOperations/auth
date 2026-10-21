import { parseArgs } from "node:util";
import { z } from "zod";

// Argument and environment parsing for scripts/recover-primary-admin.ts, kept
// out of the script so the refusal paths can be unit tested. Pure: it never
// reads process.env (the caller passes it in) and never echoes a DIRECT_URL or
// API key value, because both are secrets.

export class UsageError extends Error {}

export const USAGE = [
  "Usage:",
  "  npm run recover-primary-admin -- --email <new-pa> --operator <name> --reason <text> [--dry-run] [--demote-previous]",
  "  npm run recover-primary-admin -- --reset-mfa --email <pa> --operator <name> --reason <text> [--dry-run]",
].join("\n");

export const TRANSFER_PHRASE = "TRANSFER PRIMARY ADMIN";
export const RESET_MFA_PHRASE = "RESET PRIMARY ADMIN MFA";

export type RecoveryMode = "transfer" | "reset_mfa";

export interface RecoveryArgs {
  mode: RecoveryMode;
  email: string;
  operator: string;
  reason: string;
  dryRun: boolean;
  demotePrevious: boolean;
}

const argsSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  operator: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(10).max(500),
});

const ARG_PROBLEMS: Record<string, string> = {
  email: "--email must be a valid email address",
  operator: "--operator is required (1-100 characters)",
  reason: "--reason is required (10-500 characters)",
};

export function parseRecoveryArgs(argv: string[]): RecoveryArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        email: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
        "reset-mfa": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "demote-previous": { type: "boolean" },
      },
    }));
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : "Invalid arguments",
    );
  }

  const resetMfa = values["reset-mfa"] ?? false;
  const demotePrevious = values["demote-previous"] ?? false;
  if (resetMfa && demotePrevious) {
    throw new UsageError("--demote-previous cannot be used with --reset-mfa");
  }

  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) {
    const problems = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const name = String(issue.path[0]);
          return ARG_PROBLEMS[name] ?? `invalid --${name}`;
        }),
      ),
    ];
    throw new UsageError(problems.join("; "));
  }

  return {
    mode: resetMfa ? "reset_mfa" : "transfer",
    ...parsed.data,
    dryRun: values["dry-run"] ?? false,
    demotePrevious,
  };
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  DIRECT_URL: z.string().min(1).refine(isParseableUrl),
  SGAUTH_ENV: z.enum(["production", "dev", "preview", "local"]),
});

const resendSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().min(1),
});

export interface RecoveryEnv {
  DIRECT_URL: string;
  SGAUTH_ENV: "production" | "dev" | "preview" | "local";
  /** Absent only on a dry run, which sends nothing. */
  email: { apiKey: string; from: string } | null;
}

/** Throws a UsageError naming only the offending variables, never their values. */
export function parseRecoveryEnv(
  env: Record<string, string | undefined>,
  { dryRun }: { dryRun: boolean },
): RecoveryEnv {
  const base = envSchema.safeParse(env);
  const resend = dryRun ? null : resendSchema.safeParse(env);

  const issues = [
    ...(base.success ? [] : base.error.issues),
    ...(resend && !resend.success ? resend.error.issues : []),
  ];
  if (!base.success || (resend && !resend.success)) {
    const names = [...new Set(issues.map((issue) => issue.path.join(".")))];
    throw new UsageError(
      `Invalid environment. DIRECT_URL must be a URL, SGAUTH_ENV must be production|dev|preview|local${dryRun ? "" : ", and RESEND_API_KEY and RESEND_FROM_EMAIL are required"}. Problem with: ${names.join(", ")}`,
    );
  }
  return {
    ...base.data,
    email: resend?.success
      ? {
          apiKey: resend.data.RESEND_API_KEY,
          from: resend.data.RESEND_FROM_EMAIL,
        }
      : null,
  };
}

/** Exact and case-sensitive, after trimming the answer's surrounding space. */
export function phraseMatches(answer: string, phrase: string): boolean {
  return answer.trim() === phrase;
}
