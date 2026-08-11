import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_PAGES = 50;
const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

// ── 1. Authenticate JWT ────────────────────────────────────
export async function authenticateUser(
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

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return { supabaseAdmin, user: userData.user };
}

// ── 2. Validate upload limits + check sufficient credits ───
// Returns the number of credits this job will cost.
// Throws 400 on limit violations, 402 on insufficient credits.
export async function checkCreditsAndValidate(
  supabaseAdmin: SupabaseClient,
  userId: string,
  pageCount: number,
  fileSizeBytes: number,
): Promise<number> {
  if (pageCount > MAX_PAGES) {
    throw Object.assign(
      new Error(`PDF exceeds ${MAX_PAGES}-page limit (got ${pageCount} pages)`),
      { status: 400 },
    );
  }
  if (fileSizeBytes > MAX_SIZE_BYTES) {
    throw Object.assign(
      new Error(`PDF exceeds 25 MB limit`),
      { status: 400 },
    );
  }

  const creditsNeeded = Math.ceil(pageCount / 10);

  const { data, error } = await supabaseAdmin
    .from("credit_balance")
    .select("subscription_credits, addon_credits")
    .eq("account_id", userId)
    .single();

  if (error || !data) {
    throw Object.assign(new Error("Credit balance not found"), { status: 404 });
  }

  const available = data.subscription_credits + data.addon_credits;
  if (available < creditsNeeded) {
    throw Object.assign(
      new Error(
        `You need ${creditsNeeded} credit${creditsNeeded > 1 ? "s" : ""} but only have ${available}. ` +
          "Please purchase more to continue.",
      ),
      { status: 402 },
    );
  }

  return creditsNeeded;
}

// ── 3. Deduct credits after successful processing ──────────
// Uses charge_credits DB function: row-locked, idempotent on job_id.
// Human web-app path always draws subscription first, then addon.
export async function chargeCredits(
  supabaseAdmin: SupabaseClient,
  userId: string,
  credits: number,
  jobId: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("charge_credits", {
    p_account_id: userId,
    p_bucket_priority: ["subscription", "addon"],
    p_credits: credits,
    p_job_id: jobId,
    p_reason: "markup_job",
  });

  if (error) {
    if (error.message?.includes("INSUFFICIENT_CREDITS")) {
      // Shouldn't happen (we checked above), but guard it
      throw Object.assign(new Error("Insufficient credits"), { status: 402 });
    }
    // Log but don't throw: markup is already delivered; investigate separately
    console.error(`CRITICAL: charge_credits failed for user ${userId} job ${jobId}:`, error.message);
  }
}
