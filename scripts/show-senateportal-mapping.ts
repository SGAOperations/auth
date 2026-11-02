import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { planSenatePortalImport } from "../src/lib/import/senateportal.js";
import { readAplioState } from "../prisma/import/aplio.js";
import {
  ImportConflictError,
  ImportInputError,
} from "../prisma/import/chambers.js";
import { loadSenatePortalSource } from "../prisma/import/senateportal.js";
import { parseFlags } from "../prisma/import/aplio.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Read-only: lays out which SenatePortal account maps to which SGAuth account,
// with both sides' names and addresses, so an operator can eyeball every merge.
// Without --id-map it shows what an import would do now (a create has no SGAuth
// account yet). With --id-map it shows what an applied import did. Prints PII to
// the terminal and, with --csv, to a file: keep both off shared machines.

const USAGE =
  "Usage: npx tsx scripts/show-senateportal-mapping.ts --source <export.json> [--id-map <id-map.json>] [--csv <out.csv>] [--all]";

const idMapSchema = z.object({
  mappings: z.array(
    z.object({
      senatePortalId: z.string(),
      sgauthId: z.string(),
      outcome: z.string(),
    }),
  ),
});

type Line = {
  outcome: string;
  portalId: string;
  portalName: string;
  portalEmail: string;
  sgauthId: string;
  sgauthName: string;
  sgauthEmail: string;
  sgauthStatus: string;
  positions: string;
  check: string;
};

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function main() {
  const { values, bare } = parseFlags(
    process.argv.slice(2),
    ["--source", "--id-map", "--csv"],
    ["--all"],
  );
  const sourcePath = values.get("--source");
  if (sourcePath === undefined) throw new UsageError("--source is required");
  const env = parseSyncEnv(process.env);
  const source = await loadSenatePortalSource(sourcePath);

  let idMap: Map<string, { sgauthId: string; outcome: string }> | null = null;
  const idMapPath = values.get("--id-map");
  if (idMapPath !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(idMapPath, "utf8"));
    } catch {
      throw new ImportInputError("Cannot read the id-map file as JSON");
    }
    const parsed = idMapSchema.safeParse(raw);
    if (!parsed.success) throw new ImportInputError("Not an id-map.json file");
    idMap = new Map(
      parsed.data.mappings.map((m) => [
        m.senatePortalId,
        { sgauthId: m.sgauthId, outcome: m.outcome },
      ]),
    );
  }

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );
  console.log(
    idMap === null
      ? "Mode: preview (what an import would do now)"
      : "Mode: applied (from id-map.json)",
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planSenatePortalImport(
      source.rows,
      await readAplioState(prisma, source.rows),
    );

    const resolved = plan.rows.map((entry) => {
      const mapped = idMap?.get(entry.row.senatePortalId);
      return {
        entry,
        outcome:
          idMap === null ? entry.outcome : (mapped?.outcome ?? entry.outcome),
        sgauthId: idMap === null ? entry.userId : (mapped?.sgauthId ?? null),
      };
    });

    const ids = [
      ...new Set(
        resolved.flatMap((r) => (r.sgauthId === null ? [] : [r.sgauthId])),
      ),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        emailVerified: true,
        positions: {
          where: { position: { deletedAt: null } },
          select: { position: { select: { key: true } } },
        },
      },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const lines: Line[] = resolved
      .filter((r) => bare.has("--all") || r.entry.outcome !== "skip")
      .map(({ entry, outcome, sgauthId }) => {
        const user = sgauthId === null ? undefined : byId.get(sgauthId);
        let check = "";
        if (outcome === "create" && sgauthId === null)
          check = "new account on apply";
        else if (outcome === "skip") check = entry.reasons.join("; ");
        else if (user === undefined) check = "SGAUTH ACCOUNT NOT FOUND";
        else if (user.email.toLowerCase() !== entry.row.email)
          check = "EMAIL DIFFERS";
        else if (user.status !== "ACTIVE") check = user.status;
        else if (!user.emailVerified) check = "unverified";
        else check = "ok";
        return {
          outcome,
          portalId: entry.row.senatePortalId,
          portalName: entry.row.name ?? "",
          portalEmail: entry.row.email,
          sgauthId: sgauthId ?? "",
          sgauthName: user?.name ?? "",
          sgauthEmail: user?.email ?? "",
          sgauthStatus: user?.status ?? "",
          positions:
            user?.positions
              .map((h) => h.position.key)
              .sort()
              .join("|") ?? "",
          check,
        };
      })
      .sort(
        (a, b) =>
          a.outcome.localeCompare(b.outcome) ||
          a.portalEmail.localeCompare(b.portalEmail),
      );

    console.table(
      lines.map((l) => ({
        outcome: l.outcome,
        "portal name": l.portalName,
        "portal email": l.portalEmail,
        "SGAuth name": l.sgauthName,
        "SGAuth email": l.sgauthEmail,
        "SGAuth id": l.sgauthId,
        check: l.check,
      })),
    );
    const flagged = lines.filter(
      (l) =>
        !["ok", "new account on apply"].includes(l.check) &&
        l.outcome !== "skip",
    );
    console.log(
      `${lines.length} rows shown; ${flagged.length} flagged${flagged.length > 0 ? ": look at the check column" : ""}`,
    );

    const csvPath = values.get("--csv");
    if (csvPath !== undefined) {
      const header = Object.keys(lines[0] ?? {}) as (keyof Line)[];
      const body = lines.map((l) => header.map((k) => csvCell(l[k])).join(","));
      await writeFile(csvPath, [header.join(","), ...body].join("\n") + "\n", {
        flag: "wx",
      });
      console.log(`CSV: ${csvPath}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (
    error instanceof ImportInputError ||
    error instanceof ImportConflictError
  ) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.name : "Unexpected error");
  }
  process.exitCode = 1;
});
