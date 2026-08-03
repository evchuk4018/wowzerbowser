import "server-only";

import { createClient } from "@supabase/supabase-js";

/** The only remaining Supabase integration is the private object-storage adapter. */
export function getServerClient() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) throw new Error("Supabase Storage is not configured.");
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
