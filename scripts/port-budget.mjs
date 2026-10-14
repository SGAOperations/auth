#!/usr/bin/env node
// Per-ticket dispatch cost accounting (#188) — a self-contained script whose
// stdout *is* the verdict, following the `bin/worktrees.mjs` /
// `bin/artifacts.mjs` precedent: copied into a managed repository by
// `/port:init`, addressed through `commands.budget`. Four subcommands —
// `reset` (cockpit startup), `dispatch` (the gate), `sweep` (each tick) and
// `report` (read-only); `SKILL.md` holds every call site. The enforced
// ceiling is cumulative agent wall-clock per ticket
// (`budget.wallClockMinutes`, null = unbounded); model, dispatch count and
// outcome are recorded and reported but never enforced, because nothing in
// the harness exposes turn counts or token cost to the cockpit.
//
// **The caller runs `dispatch` last — after every other pre-dispatch veto
// and immediately before the `Agent` call.** An `allow` starts that row's
// clock, so a veto evaluated afterwards charges a whole sweep interval to a
// ticket that never dispatched. `reset` drops every row it manages to flush,
// and that dropping *is* the session scoping, exactly as
// `.temp/dispatch-log.md` documents — no clock or session id needed. The
// ledger lives on the **issue**, never the pull request, because the issue
// is the only object alive from `ready` through merge; writes are scoped to
// this script's own `## Pipeline Cost` comment, authored by `viewer`. A row
// therefore carries both numbers: `issue` keys the ledger, `dispatchNumber`
// keys the `<stage> #<n>` descriptions `--live`/`--completed` carry.
//
// Every fail direction is stated at its own site — an absent signal is never
// a passing one: a malformed ledger holds (`parseLedger`), a non-zero `gh`
// exit is not evidence of no data (`ghGraphQL`), a malformed
// `budget.wallClockMinutes` is fatal (`ceilingSecondsFrom`), and a failed
// ledger write stays `pending` (`flushPending`) — because discarding
// wall-clock really spent under-counts, the one direction this rail prevents.
//
// #293: one session log per *dispatcher*, not one per repository — `reset`,
// `sweep`, and `dispatch` all accept `--session <name>`, naming the file a
// sweep closes every open row its own caller does not vouch for. Without
// this, the cockpit's own sweep would close rows the desktop app's dispatcher
// is still running (and vice versa), undercounting wall-clock actually
// spent. Absent `--session` keeps today's single `budget-session.tsv`, so an
// adopter's existing cockpit-only usage is byte-identical. The ledger
// comment itself stays shared — it is keyed on the issue, not the caller.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

/** One clear line, no stack trace. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error) return { ok: false, stdout: '', stderr: String(res.error.message ?? res.error) };
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
const firstLine = (text, fallback) => text.trim().split('\n')[0] || fallback;

/** `null` for anything that is not a JSON *object* — an array or a bare
 *  primitive is neither a config nor a GraphQL envelope. */
function parseJsonObject(text) {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Whole seconds since `startedAt`, 0 for an unparseable one — such a row
 *  contributes nothing rather than a wild span, but is still closed. */
const elapsed = (startedAt, nowMs) => {
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
};

// --- Pure functions (exported for this repository's own layer 1 checks) -----

/** `<m>m <ss>s` below an hour, `<h>h <mm>m` at or above one: a wall-clock
 *  ceiling is routinely exceeded past the hour, where `127m 00s` reads
 *  worst. Never parsed back. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.trunc(totalSeconds || 0));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** `hold` is deliberately not reachable here — it is a caller-level state
 *  for an unreadable ledger, and this runs only once one has parsed. */
export function verdict({ secondsUsed, ceilingSeconds }) {
  if (ceilingSeconds == null) return 'allow';
  return secondsUsed >= ceilingSeconds ? 'exceeded' : 'allow';
}

/** `null` when the table does not parse — a malformed ledger is absent,
 *  never zero. Only `Seconds` is read as a number; the total line is derived
 *  by `renderLedger` and never parsed back. */
export function parseLedger(markdown) {
  const text = markdown ?? '';
  if (!/^##\s*Pipeline Cost\s*$/m.test(text)) return null;
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => /^\|\s*Stage\s*\|\s*Model\s*\|\s*Started/i.test(l));
  if (headerIdx === -1) return null;
  if (!/^\|[\s:-]+\|/.test(lines[headerIdx + 1] ?? '')) return null;
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) return null;
    const [stage, model, startedAt, secondsStr, outcome] = cells;
    const seconds = Number(secondsStr);
    if (!Number.isInteger(seconds) || seconds < 0) return null;
    rows.push({ stage, model, startedAt, seconds, outcome });
  }
  return { rows };
}

/** Byte-for-byte compatible with `parseLedger`, which is why `Seconds` is
 *  stored as an integer: the row data must survive a round trip exactly. */
export function renderLedger(rows, ceilingSeconds) {
  const total = rows.reduce((acc, r) => acc + r.seconds, 0);
  const noun = rows.length === 1 ? 'dispatch' : 'dispatches';
  const head = `**Total:** ${rows.length} ${noun} · ${total}s (${formatDuration(total)})`;
  const tail =
    ceilingSeconds == null
      ? `${head} — no ceiling configured`
      : `${head} of ${ceilingSeconds}s (${Math.round(ceilingSeconds / 60)}m) — ${Math.round((total / ceilingSeconds) * 100)}%`;
  const body = rows.map((r) => `| ${r.stage} | ${r.model} | ${r.startedAt} | ${r.seconds} | ${r.outcome} |`);
  const header = ['## Pipeline Cost', '', '| Stage | Model | Started (UTC) | Seconds | Outcome |', '| --- | --- | --- | --- | --- |'];
  return [...header, ...body, '', tail].join('\n');
}

/** An entry that does not match `"<stage> #<n>"` comes back in `invalid`, so
 *  the caller reports it and treats it as **not** live — closing the row
 *  rather than leaving it open forever, never silently dropping it. */
export function parseDescriptionList(raw) {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const wellFormed = (e) => /^[a-z]+ #\d+$/.test(e);
  return { descriptions: entries.filter(wellFormed), invalid: entries.filter((e) => !wellFormed(e)) };
}

/** Closes every open row absent from `liveDescriptions`, timing it from
 *  `nowMs`. Correlation is on `dispatchNumber` — for `review`/`revise` the
 *  pull request, not the `issue` the ledger is keyed on, since matching
 *  `issue` closed every pull-request-stage row on its first sweep. A row
 *  named in `completedDescriptions` closes `completed` — the one fact the
 *  caller holds and this argument carries, without which nothing could tell
 *  a graceful finish from a crash. Anything else closes `lost`,
 *  over-counting deliberately to bias toward visible escalation. A closed
 *  row comes back `pending`: timed, not yet flushed. */
export function closeRows(openRows, liveDescriptions, nowMs, completedDescriptions = []) {
  const live = new Set(liveDescriptions);
  const done = new Set(completedDescriptions);
  const desc = (row) => `${row.stage} #${row.dispatchNumber ?? row.issue}`;
  return {
    stillOpen: openRows.filter((row) => live.has(desc(row))),
    closed: openRows
      .filter((row) => !live.has(desc(row)))
      .map((row) => ({ ...row, seconds: elapsed(row.startedAt, nowMs), outcome: done.has(desc(row)) ? 'completed' : 'lost', state: 'pending' })),
  };
}

/** Every field named in `errors[].path` — the only unavailable parts of a
 *  partial GraphQL response. Every other alias in the same envelope is
 *  trustworthy, which is why a non-zero exit is never read as "no data". */
export function unavailableAliases(errors) {
  const paths = (errors ?? []).flatMap((e) => e?.path ?? []);
  return new Set(paths.filter((seg) => typeof seg === 'string'));
}

/** The same `Closes #N` grammar `bin/artifacts.mjs`'s `checkPrBody`
 *  validates, read from the first line only. */
export function issueFromPrBody(body) {
  const m = /^Closes #(\d+)$/.exec((body ?? '').split('\n')[0]?.trim() ?? '');
  return m ? Number(m[1]) : null;
}

/** **Absent (`undefined`/`null`) is unbounded; anything else malformed is
 *  fatal.** `"120"`, `0` and `-1` would otherwise be indistinguishable from
 *  "no ceiling configured" and disable the rail forever — and nothing
 *  validates a live config at runtime, so `minimum: 1` never sees it. */
export function ceilingSecondsFrom(cfg) {
  const minutes = cfg?.budget?.wallClockMinutes;
  if (minutes === undefined || minutes === null) return { ok: true, ceilingSeconds: null };
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) return { ok: false, offending: JSON.stringify(minutes) };
  return { ok: true, ceilingSeconds: minutes * 60 };
}

// --- Session log (.temp/budget-session.tsv) ----------------------------------
/** Tab-separated: issue, stage, model, startedAt, state, seconds, outcome,
 *  dispatchNumber. A `closed` row is kept so the session aggregate survives
 *  the row leaving the ledger's scope; a `pending` row is a close whose
 *  ledger write has not landed. An unknown state reads as `open`, an absent
 *  `dispatchNumber` falls back to `issue`, and a legacy four-field line still
 *  parses, so a session in flight survives upgrading this file. */
export function parseSessionLog(text) {
  const rows = [];
  for (const line of (text ?? '').split('\n')) {
    const [issue, stage, model, startedAt, state, seconds, outcome, dispatch] = line.split('\t');
    if (!line.trim() || !issue || !stage || !model || !startedAt) continue;
    const secs = Number(seconds);
    const dn = Number(dispatch);
    const known = state === 'pending' || state === 'closed';
    const kept = Number.isInteger(secs) && secs >= 0 ? secs : 0;
    rows.push({ issue: Number(issue), dispatchNumber: Number.isInteger(dn) && dn > 0 ? dn : Number(issue), stage, model, startedAt, state: known ? state : 'open', seconds: kept, outcome: outcome || 'lost' });
  }
  return rows;
}

export function renderSessionLog(rows) {
  const line = (r) => [r.issue, r.stage, r.model, r.startedAt, r.state ?? 'open', r.seconds ?? 0, r.outcome ?? '', r.dispatchNumber ?? r.issue].join('\t');
  return rows.length > 0 ? `${rows.map(line).join('\n')}\n` : '';
}

/** From the local log alone — no GitHub I/O, which is what makes the tick
 *  clause producible on every tick, including one that closed nothing. */
export function sessionTotals(rows, nowMs) {
  const seconds = rows.reduce((acc, r) => acc + (r.state === 'open' ? elapsed(r.startedAt, nowMs) : r.seconds ?? 0), 0);
  return { dispatches: rows.length, seconds };
}

/** The session half always prints, since it needs no ledger read; a
 *  per-ticket half is appended only for a ledger this sweep actually read,
 *  because that is the only source for a cross-session total and re-reading
 *  one every tick would buy a number that cannot have moved. */
export function renderTickClause(totals, tickets) {
  const noun = totals.dispatches === 1 ? 'dispatch' : 'dispatches';
  const per = (t) =>
    t.ceilingSeconds == null
      ? `#${t.issue} at ${formatDuration(t.secondsUsed)}, no ceiling configured`
      : `#${t.issue} at ${formatDuration(t.secondsUsed)} of its ${Math.round(t.ceilingSeconds / 60)}m ceiling (${Math.round((t.secondsUsed / t.ceilingSeconds) * 100)}%)`;
  const parts = [`session ${totals.dispatches} ${noun}`, `${formatDuration(totals.seconds)} agent wall-clock`, ...tickets.map(per)];
  return `**Budget:** ${parts.join(' · ')}`;
}

/** `undefined` → today's file, byte-identical to before `--session` existed.
 *  A well-formed name (lowercase letters, digits, dashes, 1–32 characters) →
 *  its own file. Anything else → `null`, so the caller dies rather than
 *  silently sharing (or mis-splitting) a log across callers. */
export function sessionLogName(session) {
  if (session === undefined) return 'budget-session.tsv';
  return /^[a-z][a-z0-9-]{0,31}$/.test(session) ? `budget-session-${session}.tsv` : null;
}

function sessionLogPath(mainRoot, session) {
  const name = sessionLogName(session);
  return join(mainRoot, '.temp', name);
}

function readSessionLog(mainRoot, session) {
  const path = sessionLogPath(mainRoot, session);
  return existsSync(path) ? parseSessionLog(readFileSync(path, 'utf8')) : [];
}

function writeSessionLog(mainRoot, session, rows) {
  const path = sessionLogPath(mainRoot, session);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSessionLog(rows));
}

// --- Config and repo facts ----------------------------------------------------
function resolveRoot() {
  const res = run('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel']);
  if (!res.ok) die('not a git repository (git rev-parse --show-toplevel failed).');
  return res.stdout.trim();
}

function resolveRepoAndCeiling(mainRoot) {
  const path = join(mainRoot, '.claude', 'port.config.json');
  const cfg = existsSync(path) ? parseJsonObject(readFileSync(path, 'utf8')) : null;
  if (!cfg) die('.claude/port.config.json was not found, or does not parse, at the repository root — this repository is not port-managed.');
  if (!cfg.repo) die('.claude/port.config.json declares no `repo`.');
  const ceiling = ceilingSecondsFrom(cfg);
  if (!ceiling.ok) die(`.claude/port.config.json's budget.wallClockMinutes is ${ceiling.offending} — it must be a positive integer, or null for no ceiling. Refusing to run rather than silently dropping the ceiling.`);
  return { repo: cfg.repo, ceilingSeconds: ceiling.ceilingSeconds };
}

// --- Ledger storage -----------------------------------------------------------
const offlinePath = (mainRoot, issue) => join(mainRoot, '.temp', `budget-ledger-${issue}.md`);

/** `gh` for a plain JSON command — never GraphQL, where a non-zero exit
 *  proves nothing (see `ghGraphQL`). Here it is a real failure: there is no
 *  error envelope to read instead. */
function ghJson(args) {
  const res = run('gh', args);
  if (!res.ok) return { ok: false, error: firstLine(res.stderr, `gh ${args.join(' ')} failed`) };
  const data = parseJsonObject(res.stdout);
  return data ? { ok: true, data } : { ok: false, error: `gh ${args.join(' ')} produced unparseable JSON` };
}

/** The envelope is parsed from stdout **regardless of the exit code** — `gh`
 *  exits non-zero whenever a response carries `errors` even when `data` is
 *  still usable, so only unparseable stdout or a missing `data` is a real
 *  failure and `errors[].path` names what is actually unavailable. `--jq` is
 *  never used: `gh` skips it on exactly that partial-error response. */
function ghGraphQL(query) {
  const res = run('gh', ['api', 'graphql', '-f', `query=${query}`]);
  const envelope = parseJsonObject(res.stdout);
  if (envelope == null) return { ok: false, error: firstLine(res.stderr, 'gh api graphql returned no parseable envelope') };
  if (envelope.data == null) return { ok: false, error: envelope.errors?.[0]?.message || 'gh api graphql returned an envelope carrying no data' };
  return { ok: true, data: envelope.data, unavailable: unavailableAliases(envelope.errors) };
}

function readLedgerOnline(repo, issue) {
  const [owner, name] = repo.split('/');
  // One round trip for both facts (§6): the ledger comment is scoped to this
  // script's own author, so `viewer` is needed on every read.
  const query = `query { viewer { login } repository(owner: "${owner}", name: "${name}") { issue(number: ${issue}) { comments(first: 100) { nodes { databaseId body author { login } } } } } }`;
  const absent = (error) => ({ found: false, body: null, ref: null, error });
  const res = ghGraphQL(query);
  if (!res.ok) return absent(res.error);
  for (const alias of ['viewer', 'repository', 'issue', 'comments']) {
    if (res.unavailable.has(alias)) return absent(`GitHub reported '${alias}' unavailable while reading #${issue}'s ledger`);
  }
  const login = res.data.viewer?.login;
  if (!login) return absent("GitHub returned no viewer login — cannot tell this script's own ledger comment from anyone else's");
  const nodes = res.data.repository?.issue?.comments?.nodes;
  if (!Array.isArray(nodes)) return absent(`GitHub returned no comment list for #${issue} — an absent list is not an empty one`);
  const mine = nodes.find((n) => n.body?.startsWith('## Pipeline Cost') && n.author?.login === login);
  return mine ? { found: true, body: mine.body, ref: mine.databaseId } : { found: false, body: null, ref: null };
}

/** `gh api`'s `@<file>` field syntax is how a multi-line ledger reaches the
 *  API without shell quoting of its backticks and fences. */
function writeLedgerOnline(repo, issue, existingRef, body) {
  const path = join(tmpdir(), `port-budget-${process.pid}-${Date.now()}.md`);
  writeFileSync(path, body);
  const args =
    existingRef != null
      ? ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existingRef}`, '-F', `body=@${path}`]
      : ['api', `repos/${repo}/issues/${issue}/comments`, '-F', `body=@${path}`];
  const res = run('gh', args);
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup only
  }
  return res.ok ? { ok: true } : { ok: false, error: firstLine(res.stderr, 'gh api write failed') };
}

function readLedgerRaw(mainRoot, repo, issue, offline) {
  if (!offline) return readLedgerOnline(repo, issue);
  const path = offlinePath(mainRoot, issue);
  return existsSync(path) ? { found: true, body: readFileSync(path, 'utf8'), ref: path } : { found: false, body: null, ref: null };
}

/** Reads and sums `issue`'s ledger. `{ ok: false, why }` for an unreadable
 *  or unparseable one — absent, never zero, never a clean slate. */
function readLedgerRows(mainRoot, repo, issue, offline) {
  const existing = readLedgerRaw(mainRoot, repo, issue, offline);
  if (existing.error) return { ok: false, why: existing.error };
  if (!existing.found) return { ok: true, rows: [], seconds: 0, ref: null };
  const parsed = parseLedger(existing.body);
  if (!parsed) return { ok: false, why: "its comment doesn't parse as a '## Pipeline Cost' table" };
  return { ok: true, rows: parsed.rows, seconds: parsed.rows.reduce((a, r) => a + r.seconds, 0), ref: existing.ref };
}

/** Reads first, so a concurrent write never clobbers rows this script did
 *  not just produce. `null` on an unreadable or unwritable ledger. */
function appendToLedger(mainRoot, repo, issue, offline, row, ceilingSeconds) {
  const existing = readLedgerRows(mainRoot, repo, issue, offline);
  if (!existing.ok) return null;
  const rows = [...existing.rows, row];
  const rendered = renderLedger(rows, ceilingSeconds);
  if (offline) {
    const path = offlinePath(mainRoot, issue);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
    return rows;
  }
  return writeLedgerOnline(repo, issue, existing.ref, rendered).ok ? rows : null;
}

/** Promotes each flushed `pending` row to `closed` and leaves a failure
 *  `pending` to retry — a ledger blip must never discard wall-clock really
 *  spent, since under-counting fails toward dispatch. `tickets` carries one
 *  entry per *ticket* (the last write wins, since the ledger total is
 *  cumulative), the tick clause's only cross-session source. */
function flushPending(mainRoot, repo, offline, rows, ceilingSeconds) {
  const tickets = new Map();
  const out = [];
  let failed = 0;
  for (const row of rows) {
    if (row.state !== 'pending') {
      out.push(row);
      continue;
    }
    const entry = { stage: row.stage, model: row.model, startedAt: row.startedAt, seconds: row.seconds, outcome: row.outcome };
    const ledger = appendToLedger(mainRoot, repo, row.issue, offline, entry, ceilingSeconds);
    if (ledger == null) {
      failed++;
      console.error(`FAIL  #${row.issue}: could not flush its ${row.stage} dispatch to the ledger — keeping the row for the next sweep`);
      out.push(row);
      continue;
    }
    out.push({ ...row, state: 'closed' });
    const secondsUsed = ledger.reduce((acc, r) => acc + r.seconds, 0);
    tickets.set(row.issue, { issue: row.issue, secondsUsed, ceilingSeconds });
    console.log(`closed ${row.stage} #${row.issue} · ${formatDuration(row.seconds)} · ${row.outcome} · total ${formatDuration(secondsUsed)}`);
  }
  return { rows: out, tickets: [...tickets.values()], failed };
}

// --- CLI ----------------------------------------------------------------------
const STAGES = ['plan', 'impl', 'review', 'revise'];

function parseCommonArgs(argv, spec) {
  const opts = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (spec.includes(a)) opts[a.slice(2)] = argv[++i];
    else die(`unrecognized argument '${a}'.`);
  }
  return opts;
}

/** Validates `--session` once, at the CLI boundary — every caller below
 *  resolves it through `sessionLogName` again where it actually needs the
 *  path, but a malformed name dies here rather than mid-operation. */
function requireValidSession(session) {
  if (sessionLogName(session) === null) die(`--session must be lowercase letters, digits and dashes (got '${session}').`);
}

/** `reset` and `sweep` are one operation over different live sets: close
 *  every open row the caller no longer vouches for, then flush. What each
 *  keeps afterwards is the only difference, and is its own line below. */
function closeAndFlush(mainRoot, opts, live, done) {
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);
  const rows = readSessionLog(mainRoot, opts.session);
  const nowMs = Date.now();
  const { closed, stillOpen } = closeRows(rows.filter((r) => r.state === 'open'), live, nowMs, done);
  const pending = [...rows.filter((r) => r.state !== 'open'), ...closed];
  return { ...flushPending(mainRoot, repo, opts.offline, pending, ceilingSeconds), stillOpen, nowMs, wasEmpty: rows.length === 0 };
}

function runReset(argv) {
  const opts = parseCommonArgs(argv, ['--session']);
  requireValidSession(opts.session);
  const mainRoot = resolveRoot();
  const res = closeAndFlush(mainRoot, opts, [], []);
  // Dropping every flushed row *is* the session scoping; a row whose ledger
  // write failed stays `pending`, so a blip at startup discards nothing.
  writeSessionLog(mainRoot, opts.session, res.rows.filter((r) => r.state === 'pending'));
  if (res.wasEmpty) console.log('ok    no open dispatches to close');
  process.exit(res.failed > 0 ? 1 : 0);
}

function runSweep(argv) {
  const opts = parseCommonArgs(argv, ['--live', '--completed', '--session']);
  requireValidSession(opts.session);
  const mainRoot = resolveRoot();
  const live = parseDescriptionList(opts.live);
  const done = parseDescriptionList(opts.completed);
  for (const bad of [...live.invalid, ...done.invalid]) console.log(`note  unparseable entry '${bad}' — treating it as not live`);
  const res = closeAndFlush(mainRoot, opts, live.descriptions, done.descriptions);
  // Every closed row is kept (see `parseSessionLog`).
  const all = [...res.stillOpen, ...res.rows];
  writeSessionLog(mainRoot, opts.session, all);
  // Prints on every sweep, closing tick or not (see `renderTickClause`).
  console.log(all.length === 0 ? 'note  no dispatches this session' : renderTickClause(sessionTotals(all, res.nowMs), res.tickets));
  process.exit(res.failed > 0 ? 1 : 0);
}

function runDispatch(argv) {
  const opts = parseCommonArgs(argv, ['--issue', '--pr', '--stage', '--model', '--session']);
  requireValidSession(opts.session);
  const usage = 'usage: node budget.mjs dispatch (--issue N | --pr N) --stage <plan|impl|review|revise> --model <m> [--offline] [--session <name>]';
  if ((opts.issue == null) === (opts.pr == null)) die(`dispatch needs exactly one of --issue/--pr. ${usage}`);
  if (!STAGES.includes(opts.stage)) die(`--stage must be one of ${STAGES.join(', ')}. ${usage}`);
  if (!opts.model) die(`--model is required. ${usage}`);
  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);

  let issue;
  if (opts.issue != null) {
    issue = Number(opts.issue);
    if (!Number.isInteger(issue) || issue <= 0) die(`--issue must be a positive integer. ${usage}`);
  } else {
    const pr = Number(opts.pr);
    if (!Number.isInteger(pr) || pr <= 0) die(`--pr must be a positive integer. ${usage}`);
    if (opts.offline) die('--pr resolution needs `gh` to read the pull request body — not available with --offline.');
    const view = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'body']);
    if (!view.ok) die(`could not read PR #${pr}'s body: ${view.error}`);
    issue = issueFromPrBody(view.data.body ?? '');
    if (issue == null) die(`PR #${pr}'s body has no 'Closes #N' on its first line — cannot resolve its ticket.`);
  }

  const ledger = readLedgerRows(mainRoot, repo, issue, opts.offline);
  if (!ledger.ok) {
    console.log('hold');
    console.log(`⏳ Couldn't read #${issue}'s cost ledger (${ledger.why}) — holding its dispatch one tick rather than dispatching blind.`);
    process.exit(0);
  }
  const secondsUsed = ledger.seconds;
  const v = verdict({ secondsUsed, ceilingSeconds });
  console.log(v);
  const ceilingMinutes = Math.round(ceilingSeconds / 60);
  if (v === 'exceeded') {
    console.log(`⛔ #${issue} has consumed ${formatDuration(secondsUsed)} of agent wall-clock against a ${ceilingMinutes}m ceiling — escalate instead of dispatching ${opts.stage} #${issue}.`);
    process.exit(0);
  }
  const used = `✅ #${issue} dispatch allowed — ${formatDuration(secondsUsed)}`;
  console.log(ceilingSeconds == null ? `${used} of agent wall-clock so far, no ceiling configured.` : `${used} of its ${ceilingMinutes}m ceiling used.`);
  // This row's clock starts here — the reason the caller runs the gate last.
  const dispatchNumber = opts.pr != null ? Number(opts.pr) : issue;
  const row = { issue, dispatchNumber, stage: opts.stage, model: opts.model, startedAt: new Date().toISOString(), state: 'open', seconds: 0, outcome: '' };
  writeSessionLog(mainRoot, opts.session, [...readSessionLog(mainRoot, opts.session), row]);
  process.exit(0);
}

function runReport(argv) {
  const opts = parseCommonArgs(argv, ['--issue']);
  const issue = Number(opts.issue);
  if (!Number.isInteger(issue) || issue <= 0) die('report needs --issue N.');
  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);
  const ledger = readLedgerRows(mainRoot, repo, issue, opts.offline);
  if (!ledger.ok) die(`could not read #${issue}'s cost ledger: ${ledger.why}`);
  console.log(renderLedger(ledger.rows, ceilingSeconds));
  console.log('');
  console.log(`verdict: ${verdict({ secondsUsed: ledger.seconds, ceilingSeconds })}`);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, ...rest] = process.argv.slice(2);
  const modes = { reset: runReset, dispatch: runDispatch, sweep: runSweep, report: runReport };
  if (modes[mode]) modes[mode](rest);
  else die(`unrecognized mode ${JSON.stringify(mode)}. usage: node budget.mjs <${Object.keys(modes).join('|')}> ...`);
}
