import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROTECTED_ENDPOINTS,
  checkPrismaCommand,
  endpointId,
  guardedCommand,
  hashEndpoint,
} from "./prisma-guard.mjs";

const FAKE_ID = "ep-fake-host-000000";
const FAKE = [{ branch: "fake", sha256: hashEndpoint(FAKE_ID) }];
const options = { protectedEndpoints: FAKE };

const direct = (id) =>
  `postgresql://migration:s3cret@${id}.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;
const pooled = (id) =>
  `postgresql://migration:s3cret@${id}-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;
const env = (extra = {}) => ({
  DIRECT_URL: direct("ep-other-111111"),
  ...extra,
});

const COMMANDS = [
  ["migrate", "dev"],
  ["migrate", "reset"],
  ["db", "push"],
];

test("endpointId lowercases, drops the domain and the pooler suffix", () => {
  assert.equal(
    endpointId("EP-Fake-Host-000000-pooler.us-east-1.aws.neon.tech"),
    FAKE_ID,
  );
  assert.equal(
    endpointId("ep-fake-host-000000.us-east-1.aws.neon.tech"),
    FAKE_ID,
  );
});

test("the shipped list is main and dev, as hashes only", () => {
  assert.deepEqual(
    PROTECTED_ENDPOINTS.map((entry) => entry.branch),
    ["main", "dev"],
  );
  for (const entry of PROTECTED_ENDPOINTS) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  assert.doesNotThrow(() =>
    checkPrismaCommand(["migrate", "dev"], {
      DIRECT_URL: direct("ep-example-123456"),
    }),
  );
});

test("a protected host is refused for every guarded command", () => {
  for (const args of COMMANDS) {
    for (const url of [direct(FAKE_ID), pooled(FAKE_ID)]) {
      assert.throws(
        () => checkPrismaCommand(args, { DIRECT_URL: url }, options),
        /prisma-guard: refusing "prisma .*": .*points at the Neon fake branch/,
      );
    }
  }
});

test("flags around the command do not hide it", () => {
  assert.equal(
    guardedCommand(["migrate", "dev", "--name", "x"]),
    "migrate dev",
  );
  assert.equal(
    guardedCommand(["--schema", "prisma/schema.prisma", "migrate", "dev"]),
    "migrate dev",
  );
  assert.throws(() =>
    checkPrismaCommand(
      ["--schema", "prisma/schema.prisma", "migrate", "dev"],
      { DIRECT_URL: direct(FAKE_ID) },
      options,
    ),
  );
});

test("SGAUTH_ENV production and dev refuse on any host", () => {
  for (const value of ["production", "dev"]) {
    assert.throws(
      () =>
        checkPrismaCommand(
          ["migrate", "dev"],
          env({ SGAUTH_ENV: value }),
          options,
        ),
      new RegExp(`SGAUTH_ENV is "${value}"`),
    );
  }
});

test("local, preview and unset SGAUTH_ENV allow an unprotected host", () => {
  for (const extra of [
    { SGAUTH_ENV: "local" },
    { SGAUTH_ENV: "preview" },
    {},
  ]) {
    assert.equal(
      checkPrismaCommand(["migrate", "dev"], env(extra), options),
      null,
    );
  }
});

test("a Vercel build is refused", () => {
  assert.throws(
    () =>
      checkPrismaCommand(
        ["db", "push"],
        env({ VERCEL_ENV: "preview" }),
        options,
      ),
    /this is a Vercel build/,
  );
});

test("SGAUTH_PROTECTED_DB_HOSTS adds protection", () => {
  const url = { DIRECT_URL: direct("ep-extra-222222") };
  for (const list of [
    "ep-extra-222222.us-east-1.aws.neon.tech",
    "ep-extra-222222",
    " ep-unrelated-333333 , ,ep-extra-222222 ",
  ]) {
    assert.throws(
      () =>
        checkPrismaCommand(
          ["migrate", "dev"],
          { ...url, SGAUTH_PROTECTED_DB_HOSTS: list },
          options,
        ),
      /listed in SGAUTH_PROTECTED_DB_HOSTS/,
    );
  }
  assert.equal(
    checkPrismaCommand(
      ["migrate", "dev"],
      { ...url, SGAUTH_PROTECTED_DB_HOSTS: "ep-unrelated-333333" },
      options,
    ),
    null,
  );
});

test("a missing, empty or invalid DIRECT_URL is refused without leaking", () => {
  for (const bad of [undefined, "", "not a url"]) {
    assert.throws(
      () =>
        checkPrismaCommand(["migrate", "dev"], { DIRECT_URL: bad }, options),
      /DIRECT_URL is (not set|not a valid URL)/,
    );
  }
  try {
    checkPrismaCommand(
      ["migrate", "dev"],
      { DIRECT_URL: direct(FAKE_ID) },
      options,
    );
    assert.fail("expected a refusal");
  } catch (error) {
    for (const secret of ["s3cret", "migration:", "sslmode"]) {
      assert.ok(!error.message.includes(secret), secret);
    }
  }
});

test("unguarded commands are never blocked", () => {
  const blocked = {
    SGAUTH_ENV: "production",
    DIRECT_URL: direct(FAKE_ID),
  };
  for (const args of [
    ["generate"],
    ["migrate", "deploy"],
    ["migrate", "status"],
    ["migrate", "resolve", "--rolled-back", "x"],
    ["migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma"],
    ["studio"],
  ]) {
    assert.equal(checkPrismaCommand(args, blocked, options), null);
  }
});
