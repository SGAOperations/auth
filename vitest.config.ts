import "dotenv/config";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// The db project reads only TEST_* variables, never DATABASE_URL/DIRECT_URL:
// a contributor's .env points those at the shared dev branch, and the db
// project truncates every table. The values are mapped onto DATABASE_URL and
// DIRECT_URL inside the workers only. A missing one is left out, and global
// setup raises the error.
const dbEnv: Record<string, string> = {};
if (process.env.TEST_DATABASE_URL) {
  dbEnv.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DIRECT_URL) {
  dbEnv.DIRECT_URL = process.env.TEST_DIRECT_URL;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The real entry throws outside the react-server condition.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "prisma/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts", "prisma/**/*.db.test.ts"],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/db-setup.ts"],
          // Files share one Neon branch, so they run one at a time.
          fileParallelism: false,
          // Allows for a Neon cold start.
          hookTimeout: 60_000,
          testTimeout: 15_000,
          env: dbEnv,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
      thresholds: { lines: 80 },
      reporter: ["text-summary", "text"],
    },
  },
});
