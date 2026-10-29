import "dotenv/config";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// The db project reads only TEST_* variables, never DATABASE_URL/DIRECT_URL:
// a contributor's .env points those at the shared dev branch, and the db
// project deletes rows from every table. The values are mapped onto DATABASE_URL and
// DIRECT_URL inside the workers only. A missing one is left out, and global
// setup raises the error.
const dbEnv: Record<string, string> = {};
if (process.env.TEST_DATABASE_URL) {
  dbEnv.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DIRECT_URL) {
  dbEnv.DIRECT_URL = process.env.TEST_DIRECT_URL;
}

const transferGate = {
  branches: 90,
  functions: 90,
  lines: 90,
  statements: 90,
};

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
          include: [
            "src/**/*.test.ts",
            "prisma/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
        },
      },
      {
        // The transfer suites assume no committed Primary Admin, and the
        // harness suites commit one. CI resets the test branch to its parent
        // before each run, so running these first keeps that assumption true.
        extends: true,
        test: {
          name: "db-transfer",
          include: ["src/lib/jobs/pa-transfer*.db.test.ts"],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/db-setup.ts"],
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 15_000,
          env: dbEnv,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts", "prisma/**/*.db.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "src/lib/jobs/pa-transfer*.db.test.ts",
          ],
          globalSetup: ["src/test/global-setup.ts"],
          setupFiles: ["src/test/db-setup.ts"],
          // Files share one Neon branch, so they run one at a time.
          fileParallelism: false,
          // Allows for a Neon cold start.
          hookTimeout: 60_000,
          testTimeout: 15_000,
          env: dbEnv,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
      thresholds: {
        lines: 80,
        // The rule matrix is security logic: every branch must be exercised.
        "src/lib/authz.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // The Primary Admin transfer service. One key per file, so each file
        // has to reach the bar on its own rather than average with the rest.
        "src/lib/jobs/pa-transfer.ts": transferGate,
        "src/lib/jobs/pa-transfer-actions.ts": transferGate,
        "src/lib/jobs/pa-transfer-machine.ts": transferGate,
      },
      reporter: ["text-summary", "text"],
    },
  },
});
