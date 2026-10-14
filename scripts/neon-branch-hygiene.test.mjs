import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyBranch, planCleanup } from "./neon-branch-hygiene.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

const branch = (name, extra = {}) => ({
  id: `br-${name}`,
  name,
  created_at: ago(30 * DAY),
  ...extra,
});

test("every keep rule wins even for a 30 day old branch", () => {
  const cases = [
    [branch("main"), "permanent"],
    [branch("dev"), "permanent"],
    [branch("test"), "permanent"],
    [branch("dev-alice"), "personal"],
    [branch("anything", { protected: true }), "protected"],
    [branch("anything", { default: true }), "default"],
    [branch("anything", { primary: true }), "default"],
  ];
  for (const [b, reason] of cases) {
    assert.deepEqual(classifyBranch(b, NOW), { action: "keep", reason });
  }
});

test("only allowlisted tmp-* names older than 7 days are deleted", () => {
  assert.deepEqual(classifyBranch(branch("tmp-old"), NOW), {
    action: "delete",
    reason: "older than 7 days",
  });
});

test("non-allowlisted branches are kept with a warning, however old", () => {
  for (const name of [
    "main_old_2026-10-01",
    "restore-x",
    "main-old",
    "Dev",
    "devops",
    "TMP-old",
  ]) {
    assert.deepEqual(
      classifyBranch(branch(name), NOW),
      { action: "keep", reason: "not on throwaway allowlist", warn: true },
      name,
    );
  }
});

test("planCleanup flags non-allowlisted branches and deletes only tmp-*", () => {
  const listing = [
    branch("main", { default: true }),
    branch("main_old_2026-10-01", { parent_id: "br-main" }),
    branch("restore-x", { parent_id: "br-main" }),
    branch("tmp-old", { parent_id: "br-main" }),
  ];
  const { toDelete, kept } = planCleanup(listing, NOW);
  assert.deepEqual(
    toDelete.map((d) => d.name),
    ["tmp-old"],
  );
  assert.deepEqual(
    kept.filter((k) => k.warn).map((k) => k.name),
    ["main_old_2026-10-01", "restore-x"],
  );
});

test("age boundary: exactly 7 days is kept, 7 days + 1 ms is deleted", () => {
  const exact = branch("tmp-a", { created_at: ago(7 * DAY) });
  const over = branch("tmp-b", { created_at: ago(7 * DAY + 1) });
  assert.equal(classifyBranch(exact, NOW).action, "keep");
  assert.equal(classifyBranch(over, NOW).action, "delete");
});

test("a missing or invalid created_at is kept", () => {
  const missing = { id: "br-x", name: "tmp-x" };
  const invalid = branch("tmp-y", { created_at: "not a date" });
  assert.deepEqual(classifyBranch(missing, NOW), {
    action: "keep",
    reason: "unknown age",
  });
  assert.equal(classifyBranch(invalid, NOW).action, "keep");
});

const base = () => [
  branch("main", { default: true }),
  branch("dev", { parent_id: "br-main" }),
];

test("a stale child is listed before its stale parent", () => {
  const listing = [
    ...base(),
    branch("tmp-parent", { parent_id: "br-dev" }),
    branch("tmp-child", { parent_id: "br-tmp-parent" }),
  ];
  const { toDelete, skipped } = planCleanup(listing, NOW);
  assert.deepEqual(
    toDelete.map((d) => d.name),
    ["tmp-child", "tmp-parent"],
  );
  assert.equal(skipped.length, 0);
});

test("a stale parent with a kept child is skipped", () => {
  const listing = [
    ...base(),
    branch("tmp-parent", { parent_id: "br-dev" }),
    branch("dev-alice", { parent_id: "br-tmp-parent" }),
  ];
  const { toDelete, skipped } = planCleanup(listing, NOW);
  assert.deepEqual(toDelete, []);
  assert.deepEqual(skipped, [
    {
      id: "br-tmp-parent",
      name: "tmp-parent",
      reason: "has kept child dev-alice",
    },
  ]);
});

test("a listing with no main or default branch throws", () => {
  assert.throws(
    () => planCleanup([branch("dev"), branch("tmp-a")], NOW),
    /refusing to clean up/,
  );
  assert.throws(
    () => planCleanup([branch("main"), branch("tmp-a")], NOW),
    /refusing to clean up/,
  );
});

test("running again on the listing minus the deletions deletes nothing", () => {
  const listing = [
    ...base(),
    branch("tmp-a", { parent_id: "br-dev" }),
    branch("tmp-b", { created_at: ago(DAY) }),
  ];
  const first = planCleanup(listing, NOW);
  assert.deepEqual(
    first.toDelete.map((d) => d.name),
    ["tmp-a"],
  );
  const gone = new Set(first.toDelete.map((d) => d.id));
  const second = planCleanup(
    listing.filter((b) => !gone.has(b.id)),
    NOW,
  );
  assert.deepEqual(second.toDelete, []);
});
