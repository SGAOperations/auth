import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSteps,
  checkDatabaseUrls,
  checkEnv,
  expectedSgauthEnv,
  shouldMigrate,
} from "./vercel-build.mjs";

const POOLED =
  "postgresql://runtime:s3cret@ep-x-000000-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";
const DIRECT =
  "postgresql://migration:s3cret@ep-x-000000.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";

const build = (extra = {}) => ({
  DATABASE_URL: POOLED,
  DIRECT_URL: DIRECT,
  ...extra,
});

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test("expectedSgauthEnv maps Vercel envs and refuses anything else", () => {
  assert.equal(expectedSgauthEnv("production", "main"), "production");
  assert.equal(expectedSgauthEnv("preview", "dev"), "dev");
  assert.equal(expectedSgauthEnv("preview", "322-feature"), "preview");
  for (const vercelEnv of [undefined, "", "development"]) {
    assert.throws(() => expectedSgauthEnv(vercelEnv, "dev"), /only on Vercel/);
  }
});

test("only Production and the dev Preview migrate", () => {
  assert.equal(shouldMigrate("production", "main"), true);
  assert.equal(shouldMigrate("preview", "dev"), true);
  for (const ref of [
    "322-feature",
    "main",
    "Dev",
    "dev-alice",
    "",
    undefined,
  ]) {
    assert.equal(shouldMigrate("preview", ref), false, String(ref));
  }
});

test("buildSteps leaves out migrate deploy when not migrating", () => {
  assert.deepEqual(buildSteps({ migrate: true }), [
    ["prisma", "generate"],
    ["prisma", "migrate", "deploy"],
    ["next", "build"],
  ]);
  assert.deepEqual(buildSteps({ migrate: false }), [
    ["prisma", "generate"],
    ["next", "build"],
  ]);
});

test("Production and dev builds migrate and log the direct host", () => {
  for (const [vercelEnv, ref, sgauthEnv] of [
    ["production", "main", "production"],
    ["preview", "dev", "dev"],
  ]) {
    const { lines, log } = capture();
    const plan = checkEnv(
      build({
        VERCEL_ENV: vercelEnv,
        VERCEL_GIT_COMMIT_REF: ref,
        SGAUTH_ENV: sgauthEnv,
      }),
      log,
    );
    assert.deepEqual(plan, { migrate: true });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /database host=ep-x-000000\.us-east-1/);
  }
});

test("a branch Preview skips migrations and says so", () => {
  const { lines, log } = capture();
  const plan = checkEnv(
    build({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "322-feature",
      SGAUTH_ENV: "preview",
    }),
    log,
  );
  assert.deepEqual(plan, { migrate: false });
  assert.match(lines[1], /skipping prisma migrate deploy/);
  assert.match(lines[1], /Preview of 322-feature/);
});

test("a branch Preview may omit DIRECT_URL; a migrating build may not", () => {
  const { lines, log } = capture();
  const plan = checkEnv(
    {
      DATABASE_URL: POOLED,
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "322-feature",
      SGAUTH_ENV: "preview",
    },
    log,
  );
  assert.deepEqual(plan, { migrate: false });
  assert.match(lines[0], /database host=ep-x-000000-pooler\./);

  for (const [vercelEnv, ref, sgauthEnv] of [
    ["production", "main", "production"],
    ["preview", "dev", "dev"],
  ]) {
    assert.throws(
      () =>
        checkEnv(
          {
            DATABASE_URL: POOLED,
            VERCEL_ENV: vercelEnv,
            VERCEL_GIT_COMMIT_REF: ref,
            SGAUTH_ENV: sgauthEnv,
          },
          () => {},
        ),
      /DIRECT_URL is not set/,
    );
  }
});

test("a DIRECT_URL that is set is still checked on a branch Preview", () => {
  assert.throws(
    () =>
      checkEnv(
        build({
          DIRECT_URL: DIRECT.replace("verify-full", "disable"),
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: "322-feature",
          SGAUTH_ENV: "preview",
        }),
        () => {},
      ),
    /DIRECT_URL must use sslmode=verify-full/,
  );
});

test("a mismatched SGAUTH_ENV is refused before the URLs are read", () => {
  assert.throws(
    () =>
      checkEnv(
        {
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: "dev",
          SGAUTH_ENV: "preview",
        },
        () => {},
      ),
    /SGAUTH_ENV is "preview" but this preview build of dev expects "dev"/,
  );
});

test("checkDatabaseUrls enforces sslmode and accepts the strict fallback", () => {
  assert.throws(
    () =>
      checkDatabaseUrls(
        build({ DATABASE_URL: POOLED.replace("verify-full", "require") }),
      ),
    /DATABASE_URL must use sslmode=verify-full/,
  );
  const fallback = DIRECT.replace(
    "sslmode=verify-full",
    "sslmode=require&sslaccept=strict",
  );
  assert.doesNotThrow(() => checkDatabaseUrls(build({ DIRECT_URL: fallback })));
  assert.throws(
    () => checkDatabaseUrls({ DIRECT_URL: DIRECT }),
    /DATABASE_URL is not set/,
  );
});

test("errors and log lines never carry a credential", () => {
  const messages = [];
  for (const env of [
    build({ DATABASE_URL: "not a url s3cret" }),
    build({ DIRECT_URL: "not a url s3cret" }),
    build({ DIRECT_URL: DIRECT.replace("verify-full", "disable") }),
  ]) {
    try {
      checkDatabaseUrls(env);
      assert.fail("expected a refusal");
    } catch (error) {
      messages.push(error.message);
    }
  }
  const { lines, log } = capture();
  checkEnv(
    build({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "322-feature",
      SGAUTH_ENV: "preview",
    }),
    log,
  );
  for (const text of [...messages, ...lines]) {
    for (const secret of ["s3cret", "runtime:", "migration:"]) {
      assert.ok(!text.includes(secret), `${secret} in ${text}`);
    }
  }
});
