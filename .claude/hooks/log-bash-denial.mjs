#!/usr/bin/env node
// PreToolUse hook (Bash only). Logging-only — never blocks. Appends any
// command that doesn't match the settings.json allowlist to a gitignored
// .agents/denials.log, so the cockpit can surface clusters of denied
// commands without prompting a background agent. The actual allow/deny
// enforcement is settings.json + dontAsk; this hook does not enforce
// anything, it only makes denials visible after the fact.
import fs from "node:fs";
import path from "node:path";

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
  "mkdir -p",
];

function isAllowed(cmd) {
  const trimmed = cmd.trim();
  return ALLOWED_PREFIXES.some(
    (p) => trimmed === p.trim() || trimmed.startsWith(p),
  );
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    if (input.tool_name !== "Bash") process.exit(0);
    const cmd = input.tool_input?.command ?? "";
    if (!cmd || isAllowed(cmd)) process.exit(0);

    const dir = path.join(process.cwd(), ".agents");
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}\t${cmd.replace(/\n/g, " ")}\n`;
    fs.appendFileSync(path.join(dir, "denials.log"), line);
  } catch {
    // Never let logging itself block or error out the tool call.
  }
  process.exit(0);
});
