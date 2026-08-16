import "server-only";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

function createAdminClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const globalForSupabase = globalThis as unknown as {
  supabase?: ReturnType<typeof createAdminClient>;
};

export const supabaseAdmin = globalForSupabase.supabase ?? createAdminClient();

if (process.env.NODE_ENV !== "production") {
  globalForSupabase.supabase = supabaseAdmin;
}
