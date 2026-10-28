import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  chambersExportSchema,
  formatReport,
  validateChambersExport,
  type ExportExpectations,
} from "../src/lib/import/chambers-export.js";

// Operator CLI: validates a Chambers user export file. Reads no env and touches
// no database. Exit codes: 0 valid, 1 invalid (including a count mismatch),
// 2 usage error, missing file or unparseable JSON. See
// docs/runbooks/chambers-export.md.

const USAGE =
  "Usage: npm run validate-export -- <file> [--expect-users N] [--expect-memberships N] [--expect-hashes N]\n" +
  "       npm run validate-export -- --print-schema";

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Parsed =
  | { kind: "schema" }
  | { kind: "validate"; file: string; expect: ExportExpectations };

const COUNT_FLAGS = {
  "--expect-users": "expectUsers",
  "--expect-memberships": "expectMemberships",
  "--expect-hashes": "expectHashes",
} as const satisfies Record<string, keyof ExportExpectations>;

function parseCli(args: string[]): Parsed {
  if (args.length === 1 && args[0] === "--print-schema") {
    return { kind: "schema" };
  }
  let file: string | undefined;
  const expect: ExportExpectations = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in COUNT_FLAGS) {
      const key = COUNT_FLAGS[arg as keyof typeof COUNT_FLAGS];
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new UsageError(`${arg} needs a non-negative whole number`);
      }
      expect[key] = Number(value);
    } else if (arg.startsWith("--")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new UsageError("Only one file may be given");
    }
  }
  if (file === undefined) throw new UsageError("Missing the export file path");
  return { kind: "validate", file, expect };
}

async function main() {
  const parsed = parseCli(process.argv.slice(2));

  if (parsed.kind === "schema") {
    console.log(JSON.stringify(z.toJSONSchema(chambersExportSchema), null, 2));
    return;
  }

  // A Buffer, so the checksum covers the exact bytes on disk.
  let bytes: Buffer;
  try {
    bytes = await readFile(parsed.file);
  } catch {
    throw new UsageError(`Cannot read file: ${parsed.file}`);
  }

  const result = validateChambersExport(bytes, parsed.expect);
  if (result.unparseable) {
    console.error("not valid JSON");
    process.exitCode = 2;
    return;
  }
  console.log(formatReport(result));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // Never console.error the raw error: it may carry the offending input.
  console.error(
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unexpected error",
  );
  process.exitCode = 2;
});
