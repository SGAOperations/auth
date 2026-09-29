#!/usr/bin/env node
// PreToolUse hook (Bash only). Logging-only — never blocks. Appends any
// command that doesn't match the settings.json allowlist to a gitignored
// .agents/denials.log, so the cockpit can surface clusters of denied
// commands without prompting a background agent. The actual allow/deny
// enforcement is settings.json + dontAsk; this hook does not enforce
// anything, it only makes denials visible after the fact.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ALLOWED_PREFIXES = [
  "gh ",
  "git ",
  "npm ",
  "npx shadcn",
  "npx prisma",
  "npx tsc",
  "grep",
  "egrep",
  "rg",
  "find",
  "ls",
  "wc",
  "sort",
  "uniq",
  "stat",
  "file",
  "pwd",
  "cd ",
  "cd",
  "mkdir -p",
];

// impl-agent and revise-agent run with `isolation: worktree`, so their cwd
// is a throwaway checkout that gets deleted when they finish — a log written
// relative to cwd disappears with it, which is exactly the window the
// cockpit needs to see. Resolve the real project root instead: the harness
// sets CLAUDE_PROJECT_DIR, and `git rev-parse --git-common-dir` gets us
// there from inside a worktree when it doesn't.
function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // .git/ lives at the root of the primary checkout; its parent is the root.
    return path.dirname(path.resolve(commonDir));
  } catch {
    return process.cwd();
  }
}

function matchesPrefix(segment) {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  return ALLOWED_PREFIXES.some(
    (p) => trimmed === p.trim() || trimmed.startsWith(p),
  );
}

// settings.json evaluates each segment of a compound command separately, so
// `cd x && gh y` needs BOTH `cd` and `gh` allowed. Match that here, or a
// command like `cd x && curl evil` would look allowed on its `cd` prefix
// alone and never get logged. Splitting ignores quoting, which can only
// over-report (a denial logged that wasn't one) — never the reverse.
function isAllowed(cmd) {
  return cmd
    .split(/&&|\|\||[;|]/)
    .every(matchesPrefix);
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    if (input.tool_name !== "Bash") process.exit(0);
    const cmd = input.tool_input?.command ?? "";
    if (!cmd || isAllowed(cmd)) process.exit(0);

    const dir = path.join(projectRoot(), ".agents");
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}\t${cmd.replace(/\n/g, " ")}\n`;
    fs.appendFileSync(path.join(dir, "denials.log"), line);
  } catch {
    // Never let logging itself block or error out the tool call.
  }
  process.exit(0);
});
