import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { env } from "../src/lib/env";
import { SeedRefusedError, assertSeedAllowed } from "./seed/guard.js";
import { productCreateSchema } from "../src/lib/product-input";
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

// Who sees each product follows the operator's visibility gates (issue #290).
// Base URLs must be https://<name>.northeasternsga.com (Product_baseUrl_check),
// so a Vercel deployment URL cannot be seeded here.
const DEV_PRODUCTS = [
  {
    slug: "sgauth",
    name: "SGAuth",
    baseUrl: "https://auth-dev.northeasternsga.com",
    isActive: true,
    sortOrder: 0,
    description: "Your SGA account: profile, sessions and security.",
    visibility: "EVERYONE",
  },
  {
    slug: "vaultz",
    name: "VaultZ",
    baseUrl: "https://vaultz-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 10,
    description:
      "SGA's financial reporting platform. Used for requesting expenses and internal budget management.",
    visibility: "LEADERSHIP",
  },
  {
    slug: "chambers",
    name: "Chambers",
    baseUrl: "https://chambers-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 20,
    description: "Placeholder until Chambers is onboarded.",
    visibility: "EVERYONE",
  },
  {
    slug: "aplio",
    name: "Aplio",
    baseUrl: "https://aplio-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 30,
    description: "Placeholder until Aplio is onboarded.",
    visibility: "EVERYONE",
  },
  {
    slug: "senateportal",
    name: "SenatePortal",
    baseUrl: "https://senateportal-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 40,
    description: "Placeholder until SenatePortal is onboarded.",
    visibility: "POSITIONS",
    visibleToPositionKeys: [
      "senator",
      "speaker-of-the-senate",
      "vice-president-of-academic-affairs",
      "vice-president-of-campus-affairs",
      "vice-president-of-diversity-equity-and-inclusion",
      "vice-president-of-external-affairs",
      "vice-president-of-student-involvement",
      "vice-president-of-student-success",
      "vice-president-of-operational-affairs",
      "student-body-president",
      "executive-vice-president",
      "senate-operations-coordinator",
      "legislative-affairs-coordinator",
      "senate-communications-coordinator",
      "parliamentarian",
    ],
  },
];

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

    // Placeholders stay inactive: the registry loader trusts every active
    // product's origin, and these subdomains are not deployed yet. `update: {}`
    // keeps admin edits on dev from being clobbered by a re-seed.
    for (const product of DEV_PRODUCTS) {
      const data = productCreateSchema.parse(product);
      await prisma.product.upsert({
        where: { slug: data.slug },
        update: {},
        create: data,
      });
    }
    console.log(`Dev products: ${DEV_PRODUCTS.length} ensured.`);

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
