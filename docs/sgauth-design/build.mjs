// Generates Linear-importable CSVs (one per team) and a readable Markdown ticket set.
// Usage: node build.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EPICS, TICKETS } from "./tickets-auth.mjs";
import { PRODUCT_TEAMS, PRODUCT_TICKETS } from "./tickets-products.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const PHASES = {
  0: "Phase 0 — Foundation",
  1: "Phase 1 — Core auth, sessions, SSO (MVP)",
  2: "Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ",
  3: "Phase 3 — Hardening, observability, Chambers",
  4: "Phase 4 — Aplio, SenatePath, Attendance Manager, retention",
  5: "Phase 5 — Backlog / spikes",
};

// ---------- validation ----------
const all = [
  ...TICKETS.map((t) => ({ ...t, team: "AUTH", epicName: EPICS[t.epic].name, epicLabel: EPICS[t.epic].label })),
  ...PRODUCT_TICKETS.map((t) => ({ ...t, epicName: PRODUCT_TEAMS[t.team].epic, epicLabel: PRODUCT_TEAMS[t.team].label, phase: PRODUCT_TEAMS[t.team].phase })),
];
const byId = new Map(all.map((t) => [t.id, t]));
const errors = [];
for (const t of all) {
  if (byId.get(t.id) !== t) errors.push(`duplicate id ${t.id}`);
  if (!["Urgent", "High", "Medium", "Low"].includes(t.priority)) errors.push(`${t.id}: bad priority`);
  if (![1, 2, 3, 5, 8].includes(t.estimate)) errors.push(`${t.id}: bad estimate`);
  if (!t.acceptance?.length) errors.push(`${t.id}: no acceptance criteria`);
  if (t.description.trim().startsWith("'")) errors.push(`${t.id}: description starts with an apostrophe (Linear strips it)`);
  for (const d of t.deps) if (!byId.has(d)) errors.push(`${t.id}: unknown dep ${d}`);
}
// cycle check
const visiting = new Set(), done = new Set();
function visit(id, path) {
  if (done.has(id)) return;
  if (visiting.has(id)) { errors.push(`dependency cycle: ${[...path, id].join(" -> ")}`); return; }
  visiting.add(id);
  for (const d of byId.get(id).deps) visit(d, [...path, id]);
  visiting.delete(id); done.add(id);
}
for (const t of all) visit(t.id, []);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

// ---------- helpers ----------
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const titleOf = (id) => byId.get(id)?.title ?? "";
function descriptionFor(t) {
  const deps = t.deps.length ? t.deps.map((d) => `${d} (${titleOf(d)})`).join("; ") : "none";
  const lines = [
    `**Ticket:** ${t.id}  `,
    `**Epic:** ${t.epicName}  `,
    `**Phase:** ${PHASES[t.phase]}  `,
    `**Depends on:** ${deps}`,
    ``,
    t.description.trim(),
    ``,
    `**Acceptance criteria**`,
    ...t.acceptance.map((a) => `- [ ] ${a}`),
  ];
  return lines.join("\n");
}
function labelsFor(t) {
  return [t.epicLabel, `phase:${t.phase}`, ...t.labels].join(", ");
}

// ---------- CSV per team ----------
// Columns honored by Linear's CSV importer (case-sensitive): Title, Description, Priority, Estimate, Status, Labels.
// Priority values must be the words Urgent/High/Medium/Low. Labels are ", "-separated. Status must match a workflow state name.
const HEADER = ["Title", "Description", "Priority", "Estimate", "Status", "Labels"];
const teams = ["AUTH", ...Object.keys(PRODUCT_TEAMS)];
const csvTeams = teams.filter((t) => !PRODUCT_TEAMS[t]?.noLinear);
const files = [];
for (const team of csvTeams) {
  const rows = all.filter((t) => t.team === team);
  const csv = [HEADER.map(csvCell).join(",")]
    .concat(rows.map((t) => [t.title, descriptionFor(t), t.priority, t.estimate, "Backlog", labelsFor(t)].map(csvCell).join(",")))
    .join("\r\n") + "\r\n";
  const name = `linear-import-${team}.csv`;
  writeFileSync(join(out, name), "﻿" + csv, "utf8"); // BOM helps Excel; Linear's parser tolerates it
  files.push({ name, count: rows.length });
}

// ---------- Markdown ----------
const md = [];
md.push(`# SGAuth ticket set`);
md.push(``);
md.push(`Generated from \`tickets-auth.mjs\` and \`tickets-products.mjs\`. ${all.length} tickets across ${teams.length} teams (${csvTeams.length} with Linear CSVs; Chambers has no Linear team and is a checklist only). CSVs in \`out/\` use Linear's importer columns (Title, Description, Priority, Estimate, Status, Labels); each ticket's description carries its epic, phase, and dependencies because the importer does not create projects or parent links. Red-team revisions are folded in; see \`SGAuth-red-team.md\`.`);
md.push(``);
md.push(`**Manual action item (not a ticket):** Eli exports the Chambers Supabase \`auth.users\` table (with \`encrypted_password\`) joined to \`public.users\` before that Supabase project is deleted, and stores the file in the team secrets vault. AUTH-T86 validates the file; AUTH-T87 imports it.`);
md.push(``);
md.push(`## Import instructions`);
md.push(``);
md.push(`1. In Linear, create the projects listed under **Epics** below (one per epic) in the AUTH team, and one "SGAuth integration" project in each product team.`);
md.push(`2. Settings → Import/Export → Import → CSV. Import \`linear-import-AUTH.csv\` into team AUTH; import each product file into that product's team. Map columns as-is (headers match Linear's expected names).`);
md.push(`3. After import, filter by label \`epic:*\` and bulk-move issues into the matching project. Dependencies are written as text (\`Depends on: AUTH-T03 (...)\`); add "blocked by" relations while triaging.`);
md.push(`4. Estimates are Fibonacci points (1/2/3/5/8). Set each team's estimate scale to Fibonacci before importing so values map cleanly.`);
md.push(``);
md.push(`## Phases`);
md.push(``);
for (const [k, v] of Object.entries(PHASES)) md.push(`- **${v}**`);
md.push(``);
md.push(`## Epics (Linear Projects)`);
md.push(``);
md.push(`### Team AUTH`);
md.push(``);
for (const [k, e] of Object.entries(EPICS)) {
  const n = TICKETS.filter((t) => t.epic === k);
  const pts = n.reduce((s, t) => s + t.estimate, 0);
  md.push(`- **${e.name}** (label \`${e.label}\`, ${n.length} tickets, ${pts} points): ${e.description}`);
}
md.push(``);
md.push(`### Product teams`);
md.push(``);
for (const [k, e] of Object.entries(PRODUCT_TEAMS)) {
  const n = PRODUCT_TICKETS.filter((t) => t.team === k);
  const pts = n.reduce((s, t) => s + t.estimate, 0);
  md.push(`- **${e.epic}** (team ${e.name}, ${n.length} tickets, ${pts} points, ${PHASES[e.phase]}): ${e.description}`);
}
md.push(``);
md.push(`## Summary table`);
md.push(``);
md.push(`| ID | Title | Team | Phase | Priority | Est. | Depends on |`);
md.push(`|---|---|---|---|---|---|---|`);
for (const t of all) md.push(`| ${t.id} | ${t.title} | ${t.team} | ${t.phase} | ${t.priority} | ${t.estimate} | ${t.deps.join(", ") || "—"} |`);
md.push(``);

for (const team of teams) {
  const rows = all.filter((t) => t.team === team);
  md.push(`---`);
  md.push(``);
  md.push(`# Team ${team}`);
  md.push(``);
  const groups = new Map();
  for (const t of rows) { if (!groups.has(t.epicName)) groups.set(t.epicName, []); groups.get(t.epicName).push(t); }
  for (const [epic, list] of groups) {
    md.push(`## ${epic}`);
    md.push(``);
    for (const t of list) {
      md.push(`### ${t.id} — ${t.title}`);
      md.push(``);
      md.push(`**Priority:** ${t.priority} · **Estimate:** ${t.estimate} · **Phase:** ${PHASES[t.phase]} · **Labels:** ${labelsFor(t)}  `);
      md.push(`**Depends on:** ${t.deps.length ? t.deps.map((d) => `${d} (${titleOf(d)})`).join("; ") : "none"}`);
      md.push(``);
      md.push(t.description.trim());
      md.push(``);
      md.push(`**Acceptance criteria**`);
      for (const a of t.acceptance) md.push(`- [ ] ${a}`);
      md.push(``);
    }
  }
}
writeFileSync(join(out, "SGAuth-tickets.md"), md.join("\n"), "utf8");

// ---------- stats ----------
const stats = {};
for (const t of all) {
  stats[t.team] ??= { tickets: 0, points: 0, byPhase: {} };
  stats[t.team].tickets++; stats[t.team].points += t.estimate;
  stats[t.team].byPhase[t.phase] = (stats[t.team].byPhase[t.phase] ?? 0) + 1;
}
console.log(JSON.stringify({ files, stats, total: all.length }, null, 2));
