// Runs the account-enumeration timing benchmark (AUTH-T70). It reports the
// timing delta between known and unknown emails for sign-in, sign-up,
// forgot-password and verification resend. The results are informational: the
// run exits 0 whatever the deltas are (red-team B17).
//
// Needs TEST_DATABASE_URL and TEST_DIRECT_URL, as the db test project does.
// Run it alone: a second run against the same branch skews both.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--project",
    "db",
    "src/lib/auth/enumeration-timing.db.test.ts",
  ],
  {
    env: { ...process.env, AUTH_TIMING_BENCH: "1" },
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
