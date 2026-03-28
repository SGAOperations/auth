import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "./env";

/**
 * Service-role client for trusted server-only operations (admin API).
 * Never import this module from client components or public routes without authorization.
 */
export function createAdminSupabaseClient() {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Loads a single user from `auth.users` by id (admin privilege).
 */
export function getAuthUser(supabaseUserId: string) {
  return createAdminSupabaseClient().auth.admin.getUserById(supabaseUserId);
}
