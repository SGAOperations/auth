import { z } from "zod";
import type { PeekEmailChangeResult } from "@/lib/email-change/service";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionResult,
} from "@/lib/token-links/handler";

// What the GET page of the emailed confirm link shows. Read-only: it looks the
// token up and never claims it, so a scanner pre-fetch consumes nothing.

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
  // Set by the confirm POST when it sends the person back here.
  error: z.enum(["unavailable", "expired", "fields"]).optional(),
});

export type EmailChangeView =
  | {
      state: "ready";
      token: string;
      newEmail: string;
      error?: "fields";
    }
  | { state: "expired" | "unavailable" }
  | { state: TokenActionResult };

export async function loadEmailChangeView(
  searchParams: Record<string, string | string[] | undefined>,
  peek: (token: string) => Promise<PeekEmailChangeResult>,
): Promise<EmailChangeView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  if (!parsed.success) return { state: "invalid" };
  const { token, result, error } = parsed.data;
  if (result) return { state: result };
  if (error === "unavailable") return { state: "unavailable" };
  if (!token) return { state: "invalid" };

  const peeked = await peek(token);
  if (peeked.state !== "valid") return { state: peeked.state };
  return {
    state: "ready",
    token,
    newEmail: peeked.newEmail,
    ...(error === "fields" ? { error } : {}),
  };
}
