import { spawnSync } from "node:child_process";
import { resolveTestDatabase } from "./database-env";

/**
 * Runs once before the db project. Validates the TEST_* pair, then applies
 * migrations to it. Branch reset is CI's job (ci.yml); this never calls Neon.
 */
export default function setup() {
  const { directUrl } = resolveTestDatabase(process.env);

  // dotenv does not override variables that are already set, so
  // prisma.config.ts reads this value rather than the .env DIRECT_URL.
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DIRECT_URL: directUrl },
  });
  if (result.status !== 0) {
    throw new Error(
      "prisma migrate deploy failed against TEST_DIRECT_URL (see output above)",
    );
  }
}
