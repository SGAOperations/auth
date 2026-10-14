import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  applySync,
  formatSummary,
  loadCuratedPositions,
  planSync,
  readExistingPositions,
} from "./seed/positions.js";

// Connect to whatever database is specified by DATABASE_URL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

// Both users are password-less (no Account row): passwords are set lazily.
// Addresses use the reserved .invalid TLD so no real mailbox can ever receive
// a reset link for a seeded account, and neither email is marked verified.
async function main() {
  if (process.env.SGAUTH_ENV === "production") {
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

  console.log("seeded dev-admin@ and dev-user@example.invalid");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
