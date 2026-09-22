// Computes the execution order (dependency waves) and the blocked-by pairs for Linear.
// Usage: node order.mjs
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { TICKETS } from "./tickets-auth.mjs";
import { PRODUCT_TEAMS, PRODUCT_TICKETS } from "./tickets-products.mjs";

const map = JSON.parse(readFileSync("./issue-map.json", "utf8"));
const all = [
  ...TICKETS.map((t) => ({ ...t, team: "AUTH" })),
  ...PRODUCT_TICKETS.map((t) => ({ ...t, phase: PRODUCT_TEAMS[t.team].phase })),
];
const byId = new Map(all.map((t) => [t.id, t]));
const ref = (id) => {
  const m = map[id];
  if (!m) return "(not created)";
  const repo = m.repo.split("/")[1];
  return repo === "auth" ? `#${m.number}` : `${repo}#${m.number}`;
};
const url = (id) => (map[id] ? map[id].url : null);
const link = (id) => (url(id) ? `[${ref(id)}](${url(id)})` : ref(id));

const lvl = new Map();
const depth = (id) => {
  if (lvl.has(id)) return lvl.get(id);
  let d = 0;
  for (const p of byId.get(id).deps) d = Math.max(d, depth(p) + 1);
  lvl.set(id, d);
  return d;
};
for (const t of all) depth(t.id);

const PRI = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
const waves = new Map();
for (const t of all) {
  const d = lvl.get(t.id);
  if (!waves.has(d)) waves.set(d, []);
  waves.get(d).push(t);
}
for (const ts of waves.values())
  ts.sort(
    (a, b) => PRI[a.priority] - PRI[b.priority] || a.id.localeCompare(b.id),
  );

// critical path: longest chain by levels
let end = null,
  best = -1;
for (const t of all)
  if (
    lvl.get(t.id) > best ||
    (lvl.get(t.id) === best && PRI[t.priority] < PRI[byId.get(end).priority])
  ) {
    best = lvl.get(t.id);
    end = t.id;
  }
const chain = [];
for (let cur = end; cur; ) {
  chain.unshift(cur);
  let nx = null,
    nb = -1;
  for (const p of byId.get(cur).deps)
    if (lvl.get(p) > nb) {
      nb = lvl.get(p);
      nx = p;
    }
  cur = nx;
}

const md = [];
md.push("# SGAuth execution order");
md.push("");
md.push(
  `Computed from the dependency graph in the ticket sources: ${all.length} tickets, ${all.reduce((s, t) => s + t.deps.length, 0)} blocking relations, ${waves.size} waves. Everything in a wave can start once the previous waves are done; within a wave, tickets are independent of each other and can run in parallel.`,
);
md.push("");
md.push(
  `**Longest chain (${chain.length} tickets):** ${chain.map((id) => id).join(" → ")}. This is the schedule floor: no amount of parallel work finishes SGAuth in fewer than these steps.`,
);
md.push("");
for (const [d, ts] of [...waves].sort((a, b) => a[0] - b[0])) {
  md.push(
    `## Wave ${d} — ${ts.length} tickets, ${ts.reduce((s, t) => s + t.estimate, 0)} points`,
  );
  md.push("");
  md.push("| Ticket | Issue | Pri | Pts | Title | Blocked by |");
  md.push("|---|---|---|---|---|---|");
  for (const t of ts)
    md.push(
      `| ${t.id} | ${link(t.id)} | ${t.priority} | ${t.estimate} | ${t.title} | ${t.deps.length ? t.deps.map((x) => ref(x)).join(", ") : "—"} |`,
    );
  md.push("");
}
writeFileSync("out/execution-order.md", md.join("\n"));

// blocked-by pairs, ordered so blockers come first
const rows = [
  [
    "blocked_ticket",
    "blocked_issue",
    "blocked_title",
    "blocker_ticket",
    "blocker_issue",
    "blocker_title",
  ],
];
const ordered = [...all].sort(
  (a, b) => lvl.get(a.id) - lvl.get(b.id) || a.id.localeCompare(b.id),
);
for (const t of ordered)
  for (const d of t.deps)
    rows.push([t.id, ref(t.id), t.title, d, ref(d), byId.get(d).title]);
const csv =
  rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\r\n") + "\r\n";
writeFileSync("out/blocking-relations.csv", "\uFEFF" + csv);

console.log(
  JSON.stringify(
    {
      tickets: all.length,
      relations: rows.length - 1,
      waves: waves.size,
      longestChain: chain.length,
      chain,
    },
    null,
    2,
  ),
);
