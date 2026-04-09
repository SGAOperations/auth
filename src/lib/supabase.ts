import "server-only";
import { createClient } from "@supabase/supabase-js";

const globalForSupabase = globalThis as unknown as {
  supabase?: ReturnType<typeof createClient>;
};

export const supabaseAdmin =
  globalForSupabase.supabase ??
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

if (process.env.NODE_ENV !== "production") {
  globalForSupabase.supabase = supabaseAdmin;
}
