#!/usr/bin/env node
// Daily Neon branch hygiene (#20). Lists the project's branches through the
// Neon API and deletes stray ones (for example leftover `tmp-*` throwaways) so
// the project stays under the free plan's 10-branch cap.
//
// Deletion is fail-closed: a branch is deleted only when its name matches the
// throwaway allowlist (`tmp-*`) AND it is older than 7 days. Kept, always: the
// default branch, anything Neon marks `protected`, `main`, `dev`, `test`, and
// personal `dev-*` branches. Any other branch, such as the restore runbook's
// `main_old_*` evidence branches, is kept with a warning. A branch with no
// readable creation date is kept too — nothing is ever deleted on a guess.
//
// This is CI tooling, so it reads `process.env` directly. The `src/lib/env.ts`
// rule in docs/ENGINEERING.md section 2 covers application code only.
//
// Usage: NEON_API_KEY=... NEON_PROJECT_ID=... node scripts/neon-branch-hygiene.mjs [--dry-run]
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const KEEP_NAMES = ["main", "dev", "test"];
export const PERSONAL_PREFIX = "dev-";
// The only names the job may delete. Extend deliberately: restore evidence
// branches such as `main_old_*` (docs/runbooks/neon-restore.md) must never match.
export const THROWAWAY_PATTERNS = [/^tmp-/];
export const NOT_ALLOWLISTED = "not on throwaway allowlist";
export const MAX_AGE_DAYS = 7;
export const WARN_AT = 8;
export const PLAN_CAP = 10;

const DAY_MS = 86_400_000;
const API_BASE = "https://console.neon.tech/api/v2";

/**
 * Decide what to do with one branch. The first matching rule wins. Deletion is
 * fail-closed: only an allowlisted throwaway name older than 7 days is
 * deleted; any other branch is kept, and `warn` flags the ones kept only
 * because they are not on the allowlist.
 * @returns {{ action: "keep" | "delete", reason: string, warn?: boolean }}
 */
export function classifyBranch(branch, now) {
  if (branch.default === true || branch.primary === true) {
    return { action: "keep", reason: "default" };
  }
  if (branch.protected === true) {
    return { action: "keep", reason: "protected" };
  }
  if (KEEP_NAMES.includes(branch.name)) {
    return { action: "keep", reason: "permanent" };
  }
  if (
    typeof branch.name === "string" &&
    branch.name.startsWith(PERSONAL_PREFIX)
  ) {
    return { action: "keep", reason: "personal" };
  }
  if (!THROWAWAY_PATTERNS.some((p) => p.test(branch.name))) {
    return { action: "keep", reason: NOT_ALLOWLISTED, warn: true };
  }
  const created = branch.created_at
    ? new Date(branch.created_at).getTime()
    : NaN;
  if (Number.isNaN(created)) {
    return { action: "keep", reason: "unknown age" };
  }
  if (now - created <= MAX_AGE_DAYS * DAY_MS) {
    return { action: "keep", reason: `younger than ${MAX_AGE_DAYS} days` };
  }
  return { action: "delete", reason: `older than ${MAX_AGE_DAYS} days` };
}

/**
 * Turn a branch listing into a cleanup plan. Neon refuses to delete a branch
 * that has children, so a candidate with any child that is not itself being
 * deleted is skipped, and children are always listed before their parents.
 * @returns {{ toDelete: Item[], kept: Item[], skipped: Item[] }}
 */
export function planCleanup(branches, now) {
  const hasMain = branches.some((b) => b.name === "main");
  const hasDefault = branches.some(
    (b) => b.default === true || b.primary === true,
  );
  if (!hasMain || !hasDefault) {
    throw new Error(
      "refusing to clean up: listing has no main/default branch — wrong project?",
    );
  }

  const byId = new Map(branches.map((b) => [b.id, b]));
  const children = new Map();
  for (const b of branches) {
    if (b.parent_id && byId.has(b.parent_id)) {
      if (!children.has(b.parent_id)) children.set(b.parent_id, []);
      children.get(b.parent_id).push(b);
    }
  }

  const depthOf = (b) => {
    let depth = 0;
    let cursor = b;
    while (cursor.parent_id && byId.has(cursor.parent_id)) {
      cursor = byId.get(cursor.parent_id);
      depth += 1;
      if (depth > branches.length) break;
    }
    return depth;
  };

  const verdicts = new Map(branches.map((b) => [b.id, classifyBranch(b, now)]));
  const item = (b, reason, warn) => ({
    id: b.id,
    name: b.name,
    reason,
    ...(warn ? { warn: true } : {}),
  });
  const toDelete = [];
  const kept = [];
  const skipped = [];
  const outcome = new Map();

  // Deepest first: every child is settled before its parent is considered.
  const ordered = [...branches].sort((a, b) => depthOf(b) - depthOf(a));
  for (const b of ordered) {
    const verdict = verdicts.get(b.id);
    if (verdict.action === "keep") {
      outcome.set(b.id, "kept");
      kept.push(item(b, verdict.reason, verdict.warn));
      continue;
    }
    const blocker = (children.get(b.id) ?? []).find(
      (c) => outcome.get(c.id) !== "deleted",
    );
    if (blocker) {
      outcome.set(b.id, "skipped");
      skipped.push(item(b, `has kept child ${blocker.name}`));
    } else {
      outcome.set(b.id, "deleted");
      toDelete.push(item(b, verdict.reason));
    }
  }

  return { toDelete, kept, skipped };
}

function ageDays(branch, now) {
  const created = branch.created_at
    ? new Date(branch.created_at).getTime()
    : NaN;
  return Number.isNaN(created) ? "?" : ((now - created) / DAY_MS).toFixed(1);
}

async function listBranches(projectId, headers) {
  const branches = [];
  const seen = new Set();
  let cursor = null;
  do {
    const url = new URL(`${API_BASE}/projects/${projectId}/branches`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`listing branches failed: HTTP ${res.status} ${text}`);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("listing branches failed: response was not JSON");
    }
    if (!Array.isArray(body.branches)) {
      throw new Error(
        "listing branches failed: response has no branches array",
      );
    }
    branches.push(...body.branches);
    const next = body.pagination?.next ?? null;
    if (next && seen.has(next)) {
      throw new Error("listing branches failed: pagination cursor repeated");
    }
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return branches;
}

async function deleteBranch(projectId, branchId, headers) {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/branches/${branchId}`,
    { method: "DELETE", headers },
  );
  if (res.ok) return { status: "deleted" };
  if (res.status === 404) return { status: "already gone" };
  return { status: "failed", detail: `HTTP ${res.status} ${await res.text()}` };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  for (const name of ["NEON_API_KEY", "NEON_PROJECT_ID"]) {
    if (!process.env[name]) {
      console.error(`${name} is not set`);
      process.exit(1);
    }
  }
  const projectId = process.env.NEON_PROJECT_ID;
  const headers = {
    Authorization: `Bearer ${process.env.NEON_API_KEY}`,
    Accept: "application/json",
  };
  const now = Date.now();

  let branches;
  let plan;
  try {
    branches = await listBranches(projectId, headers);
    plan = planCleanup(branches, now);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const before = branches.length;
  const rows = [];
  const byId = new Map(branches.map((b) => [b.id, b]));
  for (const k of plan.kept) rows.push({ ...k, action: "kept" });
  for (const s of plan.skipped) rows.push({ ...s, action: "skipped" });

  let deleted = 0;
  let gone = 0;
  let failed = 0;
  for (const d of plan.toDelete) {
    if (dryRun) {
      rows.push({ ...d, action: "would delete" });
      continue;
    }
    const result = await deleteBranch(projectId, d.id, headers);
    if (result.status === "deleted") deleted += 1;
    else if (result.status === "already gone") gone += 1;
    else failed += 1;
    rows.push({
      ...d,
      action: result.status,
      reason: result.detail ? `${d.reason}; ${result.detail}` : d.reason,
    });
  }

  const after = dryRun
    ? before - plan.toDelete.length
    : before - (deleted + gone);

  console.log(`Neon branch hygiene${dryRun ? " (dry run)" : ""}`);
  for (const row of rows) {
    const line = `${row.name} · ${ageDays(byId.get(row.id), now)}d · ${row.action} (${row.reason})`;
    console.log(
      row.warn
        ? `::warning::${line} — kept, never auto-deleted; remove by hand if unneeded`
        : line,
    );
  }
  console.log(
    `Neon branches: ${before} before, ${after} after cleanup (cap ${PLAN_CAP})`,
  );
  console.log(
    `deleted ${dryRun ? plan.toDelete.length : deleted + gone} · skipped ${plan.skipped.length} · failed ${failed}`,
  );
  if (after >= WARN_AT) {
    console.log(
      `::warning::Neon branches at ${after}/${PLAN_CAP} — at or above the warning threshold of ${WARN_AT}; review personal dev-* branches`,
    );
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Neon branch hygiene${dryRun ? " (dry run)" : ""}`,
      "",
      `Branches: ${before} before, ${after} after cleanup (cap ${PLAN_CAP}). Deleted ${dryRun ? plan.toDelete.length : deleted + gone}, skipped ${plan.skipped.length}, failed ${failed}.`,
      "",
      "| Branch | Age (days) | Action | Reason |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) =>
          `| ${r.name} | ${ageDays(byId.get(r.id), now)} | ${r.action} | ${r.reason} |`,
      ),
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }

  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
