import "dotenv/config";
import pg from "pg";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  JwksRotationError,
  activateStagedKey,
  formatKeyStatus,
  planActivate,
  planStage,
  readKeys,
  stageKey,
} from "../prisma/seed/jwks-rotation.js";
import { UsageError, describeTarget } from "../prisma/seed/sync-env.js";

// Standalone ops script: parses its own env and builds its own client, the same
// exception as scripts/positions-sync.ts. Dry run by default; `--apply` writes.
// Allowed in production. See docs/runbooks/rotate-secrets.md (AUTH-T69).

const USAGE = "Usage: npm run jwks:rotate [-- status|stage|activate] [--apply]";

const COMMANDS = ["status", "stage", "activate"] as const;
type Command = (typeof COMMANDS)[number];

function parseArgs(argv: string[]): { command: Command; apply: boolean } {
  const apply = argv.includes("--apply");
  const rest = argv.filter((arg) => arg !== "--apply");
  if (rest.length > 1) {
    throw new UsageError(`Unknown argument: ${rest.slice(1).join(" ")}`);
  }
  const command = rest[0] ?? "status";
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  return { command: command as Command, apply };
}

const envSchema = z.object({
  DIRECT_URL: z
    .string()
    .min(1)
    .refine((value) => URL.canParse(value)),
  SGAUTH_ENV: z.enum(["production", "dev", "preview", "local"]),
  BETTER_AUTH_SECRET: z.string().min(32),
});

// Names only: DIRECT_URL carries the migration role's password and the secret
// decrypts every signing key.
function parseEnv(raw: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new UsageError(
      `Invalid environment (DIRECT_URL, SGAUTH_ENV and BETTER_AUTH_SECRET of at least 32 characters are required). Problem with: ${names.join(", ")}`,
    );
  }
  return parsed.data;
}

async function main() {
  const { command, apply } = parseArgs(process.argv.slice(2));
  const env = parseEnv(process.env);

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const keys = await readKeys(prisma, new Date());
    console.log(formatKeyStatus(keys));
    if (command === "status") return;

    if (command === "stage") {
      planStage(keys);
      if (!apply) {
        console.log(
          "Dry run. Would create a staged key: published in the JWKS, not signing. Re-run with --apply.",
        );
        return;
      }
      const id = await stageKey(prisma, env.BETTER_AUTH_SECRET, new Date());
      console.log(
        `Staged key ${id}. Push the combined JWKS to every Supabase project before activating.`,
      );
      return;
    }

    const plan = planActivate(keys);
    if (!apply) {
      console.log(
        `Dry run. Would switch signing to ${plan.stagedId} and expire ${plan.activeId} (published for 7 more days). Re-run with --apply.`,
      );
      return;
    }
    await activateStagedKey(prisma, new Date());
    console.log(
      `Activated ${plan.stagedId}. ${plan.activeId} is expired and stays published for 7 days.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (error instanceof JwksRotationError) {
    console.error(error.message);
  } else {
    // Never console.error the raw error: some carry connection strings, and
    // DIRECT_URL holds the migration role's password.
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
