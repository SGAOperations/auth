import { z } from "zod";
import { ACCESS_REQUEST_LIMITS } from "@/lib/access-requests/limits";
import { decodeSlackText } from "@/lib/slack/command";

// Pure: parses the text after `/access`. Limits count characters after Slack's
// escaping is undone, so they match the database CHECKs (`char_length`).

export type AccessInputError =
  | "usage"
  | "missing_part"
  | "product_too_long"
  | "access_too_long"
  | "bad_characters";

export type AccessInputResult =
  | { ok: true; product: string; access: string }
  | { ok: false; error: AccessInputError };

// Backticks would break out of the code block the reply puts the string in.
const SAFE = /^[^`\p{Cc}]*$/u;

const codePoints = (value: string) => Array.from(value).length;

// The issue messages are the error codes, so the first issue names the failure.
const inputSchema = z.strictObject({
  product: z
    .string()
    .min(1, "missing_part")
    .refine((value) => codePoints(value) <= ACCESS_REQUEST_LIMITS.product, {
      message: "product_too_long",
    })
    .regex(SAFE, "bad_characters"),
  access: z
    .string()
    .min(1, "missing_part")
    .refine((value) => codePoints(value) <= ACCESS_REQUEST_LIMITS.access, {
      message: "access_too_long",
    })
    .regex(SAFE, "bad_characters"),
});

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/** `<product> | <access>`, split on the first `|`. */
export function parseAccessCommandText(text: string): AccessInputResult {
  const decoded = decodeSlackText(text).trim();
  if (decoded === "" || decoded.toLowerCase() === "help") {
    return { ok: false, error: "usage" };
  }
  const bar = decoded.indexOf("|");
  if (bar === -1) return { ok: false, error: "usage" };

  const parsed = inputSchema.safeParse({
    product: collapse(decoded.slice(0, bar)),
    access: collapse(decoded.slice(bar + 1)),
  });
  if (parsed.success) return { ok: true, ...parsed.data };
  return {
    ok: false,
    error: parsed.error.issues[0].message as AccessInputError,
  };
}
