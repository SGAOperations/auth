import assert from "node:assert/strict";
import { test } from "node:test";

import { testDatabaseProblem } from "./ci-test-db-guard.mjs";
import { hashEndpoint } from "./prisma-guard.mjs";

const FAKE_ID = "ep-fake-host-000000";
const options = {
  protectedEndpoints: [{ branch: "fake", sha256: hashEndpoint(FAKE_ID) }],
};

const direct = (id) =>
  `postgresql://migration:s3cret@${id}.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;
const pooled = (id) =>
  `postgresql://runtime:s3cret@${id}-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;
const env = (extra = {}) => ({
  TEST_DATABASE_URL: pooled("ep-test-111111"),
  TEST_DIRECT_URL: direct("ep-test-111111"),
  ...extra,
});

test("a test branch pair is safe to empty", () => {
  assert.equal(testDatabaseProblem(env(), options), null);
});

test("refuses a missing variable", () => {
  assert.equal(
    testDatabaseProblem(env({ TEST_DIRECT_URL: "" }), options),
    "TEST_DIRECT_URL is not set",
  );
});

test("refuses an invalid URL", () => {
  assert.equal(
    testDatabaseProblem(env({ TEST_DATABASE_URL: "nope" }), options),
    "TEST_DATABASE_URL is not a valid URL",
  );
});

test("refuses a protected endpoint, pooled or direct", () => {
  assert.equal(
    testDatabaseProblem(env({ TEST_DATABASE_URL: pooled(FAKE_ID) }), options),
    "TEST_DATABASE_URL points at the Neon fake branch",
  );
  assert.equal(
    testDatabaseProblem(env({ TEST_DIRECT_URL: direct(FAKE_ID) }), options),
    "TEST_DIRECT_URL points at the Neon fake branch",
  );
});

test("never puts the URL in the message", () => {
  const problem = testDatabaseProblem(
    env({ TEST_DIRECT_URL: direct(FAKE_ID) }),
    options,
  );
  assert.ok(!problem.includes("s3cret"));
  assert.ok(!problem.includes(FAKE_ID));
});
