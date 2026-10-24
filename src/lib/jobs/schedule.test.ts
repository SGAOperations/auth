import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const WORKFLOW = read(".github/workflows/scheduled-jobs.yml");

describe("scheduled jobs workflow", () => {
  it.each([
    ["7 * * * *", "pa-transfer"],
    ["*/15 * * * *", "alerts"],
    ["23 8 * * *", "retention"],
  ])("schedules %s and maps it to %s", (cron, job) => {
    expect(WORKFLOW).toContain(`- cron: "${cron}"`);
    expect(WORKFLOW).toContain(`"${cron}") job=${job} ;;`);
  });

  it("has exactly three schedules", () => {
    expect(WORKFLOW.match(/- cron:/g)).toHaveLength(3);
  });

  it("only POSTs to /api/jobs/", () => {
    expect(WORKFLOW).toContain("-X POST");
    expect(WORKFLOW).toContain('"$BASE/api/jobs/$JOB"');
    expect(WORKFLOW).not.toMatch(/-X (GET|PUT|PATCH|DELETE)/);
  });

  it("passes secrets through env, never inline in a run script", () => {
    for (const line of WORKFLOW.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (!line.includes("${{ secrets.")) continue;
      expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
  });
});

describe("vercel.json", () => {
  it("has no crons: scheduling lives in GitHub Actions", () => {
    const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    expect(config).not.toHaveProperty("crons");
  });
});
