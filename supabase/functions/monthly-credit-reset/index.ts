import { createClient } from "@supabase/supabase-js";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resets subscription_credits = plan_credits_per_cycle for all active subscribers.
  // The trg_sync_credits trigger automatically syncs this to profiles.credits_remaining.
  const { data, error } = await supabase.rpc("reset_monthly_credits");

  if (error) {
    console.error("Monthly reset error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Monthly credit reset complete:", data);
  return new Response(JSON.stringify({ ok: true, result: data }), {
    headers: { "Content-Type": "application/json" },
  });
});
