import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { env } from "../src/lib/env";
import { SeedRefusedError, assertSeedAllowed } from "./seed/guard.js";
import {
  PrimaryAdminSeedError,
  applyPrimaryAdmin,
  formatPrimaryAdminSummary,
} from "./seed/primary-admin.js";
import {
  CuratedPositionsError,
  SyncConflictError,
  applySync,
  formatSummary,
  loadCuratedPositions,
  planSync,
  readExistingPositions,
} from "./seed/positions.js";

async function main(): Promise<void> {
  // Before any client exists: a refused run makes no connection.
  assertSeedAllowed(env.SGAUTH_ENV);

  // Connect to whatever database is specified by DATABASE_URL
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const curated = await loadCuratedPositions();
    const planned = planSync(curated, await readExistingPositions(prisma));
    const { plan } = await applySync(prisma, planned);
    console.log(formatSummary(plan));

    // Both users are password-less (no Account row): passwords are set lazily.
    // Addresses use the reserved .invalid TLD so no real mailbox can ever
    // receive a reset link for a seeded account, and neither email is marked
    // verified. createMany skips existing rows without writing, so a re-run
    // changes nothing.
    const fixtures = await prisma.user.createMany({
      data: [
        {
          email: "dev-admin@example.invalid",
          name: "Dev Admin",
          isAdmin: true,
        },
        { email: "dev-user@example.invalid", name: "Dev User" },
      ],
      skipDuplicates: true,
    });
    console.log(
      fixtures.count > 0
        ? `Dev fixtures: ${fixtures.count} created`
        : "Dev fixtures already present; nothing changed.",
    );

    if (env.SGAUTH_ENV === "local") {
      if (
        env.SEED_PRIMARY_ADMIN_EMAIL !== undefined &&
        env.SEED_PRIMARY_ADMIN_PASSWORD !== undefined
      ) {
        const email = env.SEED_PRIMARY_ADMIN_EMAIL;
        const applied = await applyPrimaryAdmin(prisma, {
          email,
          password: env.SEED_PRIMARY_ADMIN_PASSWORD,
          name: env.SEED_PRIMARY_ADMIN_NAME ?? "Local Primary Admin",
        });
        console.log(formatPrimaryAdminSummary(email, applied));
      } else {
        console.log(
          "No SEED_PRIMARY_ADMIN_EMAIL set; skipping the local Primary Admin.",
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (
    error instanceof SeedRefusedError ||
    error instanceof PrimaryAdminSeedError ||
    error instanceof CuratedPositionsError ||
    error instanceof SyncConflictError
  ) {
    console.error(error.message);
  } else {
    // Never console.error the raw error: some carry connection strings or the
    // offending input.
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
