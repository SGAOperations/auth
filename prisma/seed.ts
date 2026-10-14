import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";

// Connect to whatever database is specified by DATABASE_URL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

// Both users are password-less (no Account row): passwords are set lazily.
async function main() {
  await prisma.user.upsert({
    where: { email: "dev-admin@northeastern.edu" },
    update: {},
    create: {
      email: "dev-admin@northeastern.edu",
      name: "Dev Admin",
      emailVerified: true,
      isAdmin: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "dev-user@northeastern.edu" },
    update: {},
    create: {
      email: "dev-user@northeastern.edu",
      name: "Dev User",
      emailVerified: true,
    },
  });

  console.log("seeded dev-admin@ and dev-user@northeastern.edu");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
