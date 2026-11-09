import { z } from "zod";
import { positionKeySchema } from "./position-key";

// Pure and client-safe: no database, no `server-only`.

export const MAX_SUBMITTER_POSITIONS = 50;

/** The replacement list. Keys are de-duplicated and sorted. */
export const submitterKeysInputSchema = z.strictObject({
  keys: z
    .array(positionKeySchema)
    .max(MAX_SUBMITTER_POSITIONS)
    .transform((keys) => [...new Set(keys)].sort()),
});

export type SubmitterKeysInput = z.infer<typeof submitterKeysInputSchema>;

/** Whether two key lists hold the same keys, in any order. */
export function sameKeySet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}
