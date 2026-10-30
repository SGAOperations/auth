"use server";

import { revalidatePath } from "next/cache";
import {
  profileFieldErrors,
  profileInputSchema,
  type ProfileActionResult,
} from "@/lib/account/profile";
import { updateOwnProfile } from "@/lib/account/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { canUpdateOwnProfile } from "@/lib/authz";

// Next.js compares Origin with the host for server actions, and next.config.ts
// sets no `serverActions.allowedOrigins`, so only same-origin calls get here.
// The target is always the session user; no id is read from the input.
export async function updateProfile(
  input: unknown,
): Promise<ProfileActionResult> {
  const actor = await getCurrentUser();
  if (!actor) return { ok: false, error: "unauthenticated" };

  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid",
      fieldErrors: profileFieldErrors(parsed.error),
    };
  }

  if (!canUpdateOwnProfile(actor, actor.id).allowed) {
    return { ok: false, error: "unauthenticated" };
  }

  const { updated } = await updateOwnProfile(actor.id, parsed.data);
  if (!updated) return { ok: false, error: "unauthenticated" };

  revalidatePath("/account");
  return { ok: true, profile: parsed.data };
}
