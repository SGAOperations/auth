"use server";

import { revalidatePath } from "next/cache";
import {
  AccessSubmitterError,
  setSubmitterPositionKeys,
} from "@/lib/access-submitters";
import { requireAdmin } from "@/lib/admin-api";

// Server actions get Next.js's Origin-against-Host check, which is the Origin
// rule for this mutation. No `allowedOrigins` is set, as in `products/actions.ts`.

const PATH = "/admin/access-submitters";

export type SubmitterActionResult =
  | { ok: true; unchanged?: true }
  | { ok: false; code: "FORBIDDEN" | "RATE_LIMITED" }
  | {
      ok: false;
      code: "INVALID_INPUT";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "UNKNOWN_POSITION"; unknownKeys: string[] };

/**
 * Replaces the positions allowed to submit access requests (#343). The guard
 * runs before any input is read. The service validates the keys, checks them
 * against the registry and audits the change in its own transaction.
 */
export async function saveSubmitterPositions(
  values: unknown,
): Promise<SubmitterActionResult> {
  const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
  if ("response" in guard) {
    return {
      ok: false,
      code: guard.response.status === 429 ? "RATE_LIMITED" : "FORBIDDEN",
    };
  }

  try {
    const { changed } = await setSubmitterPositionKeys(values, guard.actor.id);
    if (!changed) return { ok: true, unchanged: true };
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof AccessSubmitterError)) throw err;
    if (err.code === "INVALID_INPUT") {
      return { ok: false, code: err.code, fieldErrors: err.fieldErrors };
    }
    return { ok: false, code: err.code, unknownKeys: err.unknownKeys };
  }
}
