import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://redink.ink",
  "https://www.redink.ink",
  "https://id-preview--d0fef311-8696-4dbe-8273-73718f709c57.lovable.app",
  "https://d0fef311-8696-4dbe-8273-73718f709c57.lovable.app",
  "http://localhost:5173",
  "http://localhost:3000",
]);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Unauthorized" });

    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) return json(401, { error: "Invalid session" });

    const { price_id, success_url, cancel_url } = await req.json();
    if (!price_id || !success_url || !cancel_url) {
      return json(400, { error: "Missing price_id, success_url, or cancel_url" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await supabase
      .from("profiles").select("stripe_customer_id, email").eq("id", user.id).single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const custResp = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: profile?.email ?? user.email ?? "",
          "metadata[user_id]": user.id,
        }),
      });
      const cust = await custResp.json();
      customerId = cust.id;
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    // Check if price is recurring to set correct checkout mode
    const priceResp = await fetch(`https://api.stripe.com/v1/prices/${price_id}`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    const price = await priceResp.json();
    const mode = price.recurring ? "subscription" : "payment";

    const params = new URLSearchParams({
      customer: customerId,
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": "1",
      mode,
      success_url,
      cancel_url,
      "metadata[user_id]": user.id,
    });

    const sessionResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const session = await sessionResp.json();

    if (session.error) {
      console.error("Stripe checkout error:", session.error);
      return json(400, { error: session.error.message });
    }

    return json(200, { url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return json(500, { error: "Internal server error" });
  }
});
