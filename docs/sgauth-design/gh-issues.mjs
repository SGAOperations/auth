// Creates the SGAuth tickets as GitHub Issues in the SGAOperations repos, for Linear's GitHub importer.
// Usage:
//   node gh-issues.mjs create AUTH|VAULTZ|CHAMBERS|APLIO|SENATEPATH   # resumable; skips ids already in issue-map.json
//   node gh-issues.mjs link                                              # rewrites "Depends on" lines with issue links
//   node gh-issues.mjs labels TEAM                                       # creates the labels used by that team's tickets
// Requires the gh CLI authenticated with write access (issues) on the target repo.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EPICS, TICKETS } from "./tickets-auth.mjs";
import { PRODUCT_TEAMS, PRODUCT_TICKETS } from "./tickets-products.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAP_FILE = join(here, "issue-map.json");
const TMP = join(here, "out", "tmp");
mkdirSync(TMP, { recursive: true });

const REPOS = {
  AUTH: "auth",
  VAULTZ: "vaultz",
  CHAMBERS: "chambers",
  APLIO: "aplio",
  SENATEPATH: "senate-path",
}; // ATTENDANCE (SenatePortal) skipped
const ORG = "SGAOperations";
const PHASES = {
  0: "Phase 0 — Foundation",
  1: "Phase 1 — Core auth, sessions, SSO (MVP)",
  2: "Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ",
  3: "Phase 3 — Hardening, observability, Chambers",
  4: "Phase 4 — Aplio, SenatePath, retention",
  5: "Phase 5 — Backlog / spikes",
};
const LABEL_COLORS = { epic: "5319e7", phase: "0e8a16", default: "c5def5" };

const all = [
  ...TICKETS.map((t) => ({
    ...t,
    team: "AUTH",
    epicName: EPICS[t.epic].name,
    epicLabel: EPICS[t.epic].label,
  })),
  ...PRODUCT_TICKETS.map((t) => ({
    ...t,
    epicName: PRODUCT_TEAMS[t.team].epic,
    epicLabel: PRODUCT_TEAMS[t.team].label,
    phase: PRODUCT_TEAMS[t.team].phase,
  })),
].filter((t) => REPOS[t.team]);
const byId = new Map(all.map((t) => [t.id, t]));

const map = existsSync(MAP_FILE)
  ? JSON.parse(readFileSync(MAP_FILE, "utf8"))
  : {};
const saveMap = () =>
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + "\n");

function gh(args, input) {
  const opts = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  if (input !== undefined) opts.input = input;
  return execFileSync("gh", args, opts);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const labelsFor = (t) => [t.epicLabel, `phase:${t.phase}`, ...t.labels];

function depRef(id, fromTeam) {
  const t = byId.get(id);
  const m = map[id];
  if (!t) return id;
  if (!m) return `${id} (${t.title})`;
  const sameRepo = REPOS[t.team] === REPOS[fromTeam];
  const link = sameRepo
    ? `#${m.number}`
    : `${ORG}/${REPOS[t.team]}#${m.number}`;
  return `${link} — ${id} ${t.title}`;
}

function body(t) {
  const deps = t.deps.length
    ? t.deps.map((d) => `- ${depRef(d, t.team)}`).join("\n")
    : "- none";
  return [
    `**Ticket:** ${t.id} · **Epic:** ${t.epicName} · **Phase:** ${PHASES[t.phase]}`,
    `**Priority:** ${t.priority} · **Estimate:** ${t.estimate} points · **Labels:** ${labelsFor(t).join(", ")}`,
    ``,
    `**Depends on:**`,
    deps,
    ``,
    t.description.trim(),
    ``,
    `**Acceptance criteria**`,
    ...t.acceptance.map((a) => `- [ ] ${a}`),
    ``,
    `<sub>Generated from the SGAuth design (docs/sgauth-design in SGAOperations/auth). SGAuth is built on Neon and does not use Supabase.</sub>`,
  ].join("\n");
}

async function createLabels(team) {
  const repo = `${ORG}/${REPOS[team]}`;
  const names = new Set();
  for (const t of all.filter((x) => x.team === team))
    labelsFor(t).forEach((l) => names.add(l));
  for (const name of names) {
    const color = name.startsWith("epic:")
      ? LABEL_COLORS.epic
      : name.startsWith("phase:")
        ? LABEL_COLORS.phase
        : LABEL_COLORS.default;
    try {
      gh(["label", "create", name, "-R", repo, "--color", color, "--force"]);
      console.log(`label ok: ${repo} ${name}`);
    } catch (e) {
      console.error(
        `label FAILED: ${repo} ${name}: ${String(e.stderr || e.message).trim()}`,
      );
      return false;
    }
  }
  return true;
}

async function create(team, { withLabels }) {
  const repo = `${ORG}/${REPOS[team]}`;
  const rows = all.filter((t) => t.team === team);
  let n = 0;
  for (const t of rows) {
    if (map[t.id]) {
      console.log(`skip (exists): ${t.id} -> #${map[t.id].number}`);
      continue;
    }
    const payload = { title: t.title, body: body(t) };
    if (withLabels) payload.labels = labelsFor(t);
    const file = join(TMP, `${t.id}.json`);
    writeFileSync(file, JSON.stringify(payload));
    try {
      const res = JSON.parse(
        gh([
          "api",
          `repos/${repo}/issues`,
          "--method",
          "POST",
          "--input",
          file,
        ]),
      );
      map[t.id] = { repo, number: res.number, url: res.html_url };
      saveMap();
      console.log(`created: ${t.id} -> ${res.html_url}`);
    } catch (e) {
      console.error(`FAILED: ${t.id}: ${String(e.stderr || e.message).trim()}`);
      process.exit(1);
    }
    n++;
    await sleep(3000); // stay under GitHub's content-creation abuse limits
  }
  console.log(`done ${team}: ${n} created`);
}

async function link() {
  let n = 0;
  for (const t of all) {
    const m = map[t.id];
    if (!m) continue;
    if (!t.deps.length) continue;
    const payload = { body: body(t) };
    const file = join(TMP, `${t.id}.patch.json`);
    writeFileSync(file, JSON.stringify(payload));
    try {
      gh([
        "api",
        `repos/${m.repo}/issues/${m.number}`,
        "--method",
        "PATCH",
        "--input",
        file,
      ]);
      console.log(`linked: ${t.id} (#${m.number})`);
      n++;
    } catch (e) {
      console.error(
        `FAILED link ${t.id}: ${String(e.stderr || e.message).trim()}`,
      );
      process.exit(1);
    }
    await sleep(1500);
  }
  console.log(`done link: ${n} updated`);
}

async function relabel(team) {
  let n = 0;
  for (const t of all.filter((x) => x.team === team)) {
    const m = map[t.id];
    if (!m) continue;
    const file = join(TMP, `${t.id}.labels.json`);
    writeFileSync(file, JSON.stringify({ labels: labelsFor(t) }));
    try {
      gh([
        "api",
        `repos/${m.repo}/issues/${m.number}/labels`,
        "--method",
        "PUT",
        "--input",
        file,
      ]);
      console.log(`relabeled: ${t.id} (#${m.number})`);
      n++;
    } catch (e) {
      console.error(
        `FAILED relabel ${t.id}: ${String(e.stderr || e.message).trim()}`,
      );
      process.exit(1);
    }
    await sleep(1500);
  }
  console.log(`done relabel ${team}: ${n}`);
}

// Re-renders title + body for the given ticket ids (or all created tickets) from the current sources.
async function update(ids) {
  const targets = ids.length ? ids : all.map((t) => t.id);
  let n = 0;
  for (const id of targets) {
    const t = byId.get(id),
      m = map[id];
    if (!t || !m) {
      console.log(`skip (not created): ${id}`);
      continue;
    }
    const file = join(TMP, `${id}.update.json`);
    writeFileSync(file, JSON.stringify({ title: t.title, body: body(t) }));
    try {
      gh([
        "api",
        `repos/${m.repo}/issues/${m.number}`,
        "--method",
        "PATCH",
        "--input",
        file,
      ]);
      console.log(`updated: ${id} (#${m.number})`);
      n++;
    } catch (e) {
      console.error(
        `FAILED update ${id}: ${String(e.stderr || e.message).trim()}`,
      );
      process.exit(1);
    }
    await sleep(1500);
  }
  console.log(`done update: ${n}`);
}

const [cmd, team, flag] = process.argv.slice(2);
if (cmd === "update") {
  await update(process.argv.slice(3));
  process.exit(0);
}
if (cmd === "labels") {
  if (!REPOS[team]) throw new Error("unknown team");
  await createLabels(team);
} else if (cmd === "relabel") {
  if (!REPOS[team]) throw new Error("unknown team");
  await relabel(team);
} else if (cmd === "create") {
  if (!REPOS[team]) throw new Error("unknown team");
  await create(team, { withLabels: flag !== "--no-labels" });
} else if (cmd === "link") await link();
else
  console.log(
    "usage: node gh-issues.mjs labels TEAM | create TEAM [--no-labels] | link",
  );
