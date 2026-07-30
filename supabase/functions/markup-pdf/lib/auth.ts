import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export async function authenticateAndCheckCredits(
  req: Request,
): Promise<{ supabaseAdmin: SupabaseClient; user: User }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw Object.assign(new Error("Missing Authorization header"), { status: 401 });
  }

  const supabaseUserScoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await supabaseUserScoped.auth.getUser();
  if (userError || !userData.user) {
    throw Object.assign(new Error("Invalid or expired session"), { status: 401 });
  }

  const user = userData.user;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("credits_remaining")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    throw Object.assign(new Error("Profile not found"), { status: 404 });
  }

  if (profile.credits_remaining <= 0) {
    throw Object.assign(
      new Error("You have no credits remaining. Please purchase more to continue."),
      { status: 402 },
    );
  }

  return { supabaseAdmin, user };
}

export async function deductCredit(supabaseAdmin: SupabaseClient, userId: string) {
  const { error } = await supabaseAdmin.rpc("decrement_credit", { p_user_id: userId });
  if (error) {
    console.error(`CRITICAL: failed to deduct credit for user ${userId}:`, error.message);
  }
}
