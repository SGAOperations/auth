import { z } from "zod";

// Argument and environment parsing for scripts/positions-sync.ts, kept out of
// the script so the refusal paths can be unit tested. Nothing here ever echoes
// a DIRECT_URL value: it carries the migration role's password.

export class UsageError extends Error {}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const syncEnvSchema = z.object({
  DIRECT_URL: z.string().min(1).refine(isParseableUrl),
  SGAUTH_ENV: z.enum(["production", "dev", "preview", "local"]),
});

export type SyncEnv = z.infer<typeof syncEnvSchema>;

export function parseArgs(argv: string[]): { apply: boolean } {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument: ${unknown.join(" ")}`);
  }
  return { apply: argv.includes("--apply") };
}

/** Throws a UsageError naming only the offending variables, never their values. */
export function parseSyncEnv(env: Record<string, string | undefined>): SyncEnv {
  const parsed = syncEnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new UsageError(
      `Invalid environment (DIRECT_URL must be a URL and SGAUTH_ENV=production|dev|preview|local is required). Problem with: ${names.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Host and database only: never the credentials. */
export function describeTarget(url: string): string {
  const { host, pathname } = new URL(url);
  return `${host}/${pathname.replace(/^\//, "")}`;
}
