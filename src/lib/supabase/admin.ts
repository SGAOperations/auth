import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "./env";

const globalForAdmin = globalThis as unknown as {
  supabaseAdmin?: SupabaseClient;
};

function createAdminClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Service-role client for trusted server-only operations (admin API).
 * Reuses one instance per runtime (same pattern as Prisma in dev / long-lived Node).
 * Never import this module from client components or public routes without authorization.
 */
export function createAdminSupabaseClient(): SupabaseClient {
  if (!globalForAdmin.supabaseAdmin) {
    globalForAdmin.supabaseAdmin = createAdminClient();
  }
  return globalForAdmin.supabaseAdmin;
}

/**
 * Loads a single user from `auth.users` by id (admin privilege).
 */
export function getAuthUser(supabaseUserId: string) {
  return createAdminSupabaseClient().auth.admin.getUserById(supabaseUserId);
}
