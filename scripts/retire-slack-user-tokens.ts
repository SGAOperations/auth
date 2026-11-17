import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { parseVersionedSecrets } from "../src/lib/env-schema";
import {
  retireSlackUserTokens,
  slackTokenKey,
} from "../src/lib/slack/user-token-retirement";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Retires the Slack user tokens leaders granted for title updates (#390): revokes
// each at Slack and deletes its row with an audit row. Standalone ops script,
// like scripts/import-slack-links.ts: it parses its own env and builds its own
// client, and holding the target's DIRECT_URL is the authorization. Like the
// break-glass script it does not load .env, so a stray local DIRECT_URL can
// never be used by accident. Needs the
// target's BETTER_AUTH_SECRET (and BETTER_AUTH_SECRETS once rotated) to read the
// stored tokens. Prints counts and SGAuth ids, never a Slack id or a token.
// See docs/runbooks/slack-token-retirement.md.

const USAGE = "Usage: npm run slack:retire-tokens -- (--dry-run | --apply)";

function parseArgs(argv: string[]): { apply: boolean } {
  const [flag, ...rest] = argv;
  if (rest.length > 0 || (flag !== "--dry-run" && flag !== "--apply")) {
    throw new UsageError("Pass exactly one of --dry-run or --apply.");
  }
  return { apply: flag === "--apply" };
}

function parseSecrets(raw: Record<string, string | undefined>) {
  const legacySecret = raw.BETTER_AUTH_SECRET;
  if (!legacySecret || legacySecret.length < 32) {
    throw new UsageError(
      "BETTER_AUTH_SECRET must be set to the target's secret (at least 32 characters).",
    );
  }
  const versioned = raw.BETTER_AUTH_SECRETS;
  try {
    return {
      legacySecret,
      secrets: versioned ? parseVersionedSecrets(versioned) : undefined,
    };
  } catch (error) {
    // The parser's errors name the entry by position and never carry a value.
    throw new UsageError(
      `Invalid BETTER_AUTH_SECRETS: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);
  const key = slackTokenKey(parseSecrets(process.env));

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const result = await retireSlackUserTokens(prisma, {
      apply: args.apply,
      key,
    });
    console.log(`Found ${result.found} stored Slack user tokens.`);
    if (!args.apply) {
      console.log("Dry run. Nothing was written. Re-run with --apply.");
      return 0;
    }
    console.log(
      `Revoked ${result.revoked}, already invalid ${result.alreadyInvalid}, failed ${result.failedUserIds.length}.`,
    );
    if (result.failedUserIds.length > 0) {
      console.error(
        "Slack did not revoke the tokens of these SGAuth user ids. Their rows are deleted; remove the app's authorization for each person in Slack admin:",
      );
      for (const id of result.failedUserIds) console.error(id);
      return 1;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
    } else {
      // Never print error.message: Prisma errors echo the call's arguments.
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? ` (${error.code})`
          : "";
      console.error(
        error instanceof Error ? `${error.name}${code}` : "Unexpected error",
      );
    }
    process.exitCode = 1;
  },
);
