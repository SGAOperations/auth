// Runs before ci.yml empties a test database (scripts/ci-reset-test-db.sql).
// The reset drops every table, so it must never reach Neon main or dev, even
// if a NEON_TEST_* secret were set to the wrong URL. Exits non-zero, naming
// the variable but never printing a URL.
import { pathToFileURL } from "node:url";

import {
  PROTECTED_ENDPOINTS,
  endpointId,
  hashEndpoint,
} from "./prisma-guard.mjs";

const VARIABLES = ["TEST_DATABASE_URL", "TEST_DIRECT_URL"];

/** The first problem with the TEST_* pair, or null when it is safe to empty. */
export function testDatabaseProblem(
  env,
  { protectedEndpoints = PROTECTED_ENDPOINTS } = {},
) {
  for (const name of VARIABLES) {
    const raw = env[name];
    if (!raw) return `${name} is not set`;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return `${name} is not a valid URL`;
    }
    const hash = hashEndpoint(endpointId(url.hostname));
    const hit = protectedEndpoints.find((e) => e.sha256 === hash);
    if (hit) return `${name} points at the Neon ${hit.branch} branch`;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = testDatabaseProblem(process.env);
  if (problem) {
    console.error(`::error::${problem}; refusing to empty it.`);
    process.exit(1);
  }
}
