import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";

// Connect to whatever database is specified by DATABASE_URL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);

const prisma = new PrismaClient({ adapter });

async function main() {
  // Fake Supabase user IDs
  const adminSupabaseId = "00000000-0000-0000-0000-000000000001";
  const userSupabaseId = "00000000-0000-0000-0000-000000000002";

  const admin = await prisma.user.upsert({
    where: { supabaseUserId: adminSupabaseId },
    update: {},
    create: { supabaseUserId: adminSupabaseId, isAdmin: true },
  });

  const user = await prisma.user.upsert({
    where: { supabaseUserId: userSupabaseId },
    update: {},
    create: { supabaseUserId: userSupabaseId, isAdmin: false },
  });

  const project1 = await prisma.project.create({
    data: { name: "Attendance Manager", description: "Cool project" },
  });

  const project2 = await prisma.project.create({
    data: { name: "Website Creation", description: "Less project" },
  });

  await prisma.userProject.createMany({
    data: [
      { userId: admin.id, projectId: project1.id },
      { userId: admin.id, projectId: project2.id },
      { userId: user.id, projectId: project1.id },
    ],
    skipDuplicates: true,
  });

  await prisma.session.create({
    data: {
      userId: admin.id,
      projectId: project1.id,
      token: "admin-session-token",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h
    },
  });

  console.log("data seeded!");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
