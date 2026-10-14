import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { env } from "../src/lib/env";
import { productCreateSchema } from "../src/lib/product-input";
import {
  applySync,
  formatSummary,
  loadCuratedPositions,
  planSync,
  readExistingPositions,
} from "./seed/positions.js";

// Connect to whatever database is specified by DATABASE_URL
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

const DEV_PRODUCTS = [
  {
    slug: "sgauth",
    name: "SGAuth",
    baseUrl: "https://auth-dev.northeasternsga.com",
    isActive: true,
    sortOrder: 0,
    description: "Your SGA account: profile, sessions and security.",
  },
  {
    slug: "vaultz",
    name: "VaultZ",
    baseUrl: "https://vaultz-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 10,
    description: "Placeholder until VaultZ is onboarded.",
  },
  {
    slug: "chambers",
    name: "Chambers",
    baseUrl: "https://chambers-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 20,
    description: "Placeholder until Chambers is onboarded.",
  },
  {
    slug: "aplio",
    name: "Aplio",
    baseUrl: "https://aplio-dev.northeasternsga.com",
    isActive: false,
    sortOrder: 30,
    description: "Placeholder until Aplio is onboarded.",
  },
];

// Both users are password-less (no Account row): passwords are set lazily.
// Addresses use the reserved .invalid TLD so no real mailbox can ever receive
// a reset link for a seeded account, and neither email is marked verified.
async function main() {
  if (env.SGAUTH_ENV === "production") {
    throw new Error("Refusing to seed dev fixtures when SGAUTH_ENV=production");
  }

  const curated = await loadCuratedPositions();
  const planned = planSync(curated, await readExistingPositions(prisma));
  const { plan } = await applySync(prisma, planned);
  console.log(formatSummary(plan));

  await prisma.user.upsert({
    where: { email: "dev-admin@example.invalid" },
    update: {},
    create: {
      email: "dev-admin@example.invalid",
      name: "Dev Admin",
      isAdmin: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "dev-user@example.invalid" },
    update: {},
    create: {
      email: "dev-user@example.invalid",
      name: "Dev User",
    },
  });

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

  console.log(
    "seeded dev-admin@ and dev-user@example.invalid, and the dev products",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
