import { z } from "zod";

// Pure and client-safe: no database, no `server-only`. The account form and the
// server action parse with the same schema, so both sides agree.

export const NAME_MAX = 100;
export const PREFERRED_NAME_MAX = 50;

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
const CONTROL_MESSAGE = "Names can't contain control characters.";

const name = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .max(NAME_MAX, `Name must be ${NAME_MAX} characters or fewer.`)
  .regex(NO_CONTROL_CHARACTERS, CONTROL_MESSAGE);

const preferredName = z
  .string()
  .trim()
  .max(
    PREFERRED_NAME_MAX,
    `Preferred name must be ${PREFERRED_NAME_MAX} characters or fewer.`,
  )
  .regex(NO_CONTROL_CHARACTERS, CONTROL_MESSAGE)
  .nullish()
  .transform((value) => (value ? value : null));

/** Strict: an unknown key (`email`, `image`, `id`) fails rather than being dropped. */
export const profileInputSchema = z.strictObject({ name, preferredName });

export type ProfileInput = z.output<typeof profileInputSchema>;
export type ProfileFormValues = z.input<typeof profileInputSchema>;

export type ProfileField = "name" | "preferredName";

export type ProfileActionResult =
  | { ok: true; profile: ProfileInput }
  | {
      ok: false;
      error: "invalid";
      fieldErrors: Partial<Record<ProfileField, string>>;
    }
  | { ok: false; error: "unauthenticated" };

/** The first message of each field that failed, for the form to show inline. */
export function profileFieldErrors(
  error: z.ZodError,
): Partial<Record<ProfileField, string>> {
  const fieldErrors: Partial<Record<ProfileField, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if ((key === "name" || key === "preferredName") && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
