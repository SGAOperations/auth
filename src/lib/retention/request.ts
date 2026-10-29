import { z } from "zod";
import { JobInputError } from "@/lib/jobs/handler";

const query = z.object({ dryRun: z.enum(["1", "true"]).optional() });

/**
 * `?dryRun=1` (or `true`) counts everything and writes nothing. Any other value
 * is refused rather than read as "no": a typo must not turn a rehearsal into a
 * real run.
 */
export function parseDryRun(request: Request): boolean {
  const parsed = query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) throw new JobInputError("dryRun must be 1 or true");
  return parsed.data.dryRun !== undefined;
}
