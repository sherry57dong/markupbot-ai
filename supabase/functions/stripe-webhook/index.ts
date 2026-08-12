import { createClient } from "@supabase/supabase-js";
import { PRICE_CONFIG } from "../_shared/billing-config.ts";

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function verifyStripeSignature(rawBody: string, sigHeader: string): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const chunk of sigHeader.split(",")) {
    const eq = chunk.indexOf("=");
    parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  const { t: timestamp, v1: expectedSig } = parts;
  if (!timestamp || !expectedSig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const computed = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === expectedSig;
}

async function stripeFetch(path: string) {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return resp.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") ?? "";

  if (!await verifyStripeSignature(rawBody, sigHeader)) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(rawBody);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object, supabase);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object, supabase);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object, supabase);
        break;
    }
  } catch (err) {
    console.error("Webhook error:", event.type, err);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});

// deno-lint-ignore no-explicit-any
async function handleCheckoutCompleted(session: any, supabase: ReturnType<typeof createClient>) {
  const userId = session.metadata?.user_id;
  if (!userId) { console.error("Missing user_id in checkout metadata"); return; }

  await supabase.from("profiles")
    .update({ stripe_customer_id: session.customer })
    .eq("id", userId);

  if (session.mode === "subscription") {
    const sub = await stripeFetch(`/subscriptions/${session.subscription}`);
    const priceId: string = sub.items?.data[0]?.price?.id;
    const plan = PRICE_CONFIG[priceId];
    if (!plan) { console.error("Unknown subscription price:", priceId); return; }

    await supabase.rpc("grant_credits", {
      p_account_id: userId,
      p_bucket: "subscription",
      p_amount: plan.credits,
      p_reason: "subscription_start",
      p_stripe_ref: session.id,
      p_set_not_increment: true,
    });
    await supabase.from("credit_balance")
      .update({ plan_credits_per_cycle: plan.credits })
      .eq("account_id", userId);

  } else if (session.mode === "payment") {
    const items = await stripeFetch(`/checkout/sessions/${session.id}/line_items`);
    const priceId: string = items.data?.[0]?.price?.id;
    const plan = PRICE_CONFIG[priceId];
    if (!plan) { console.error("Unknown addon price:", priceId); return; }

    await supabase.rpc("grant_credits", {
      p_account_id: userId,
      p_bucket: "addon",
      p_amount: plan.credits,
      p_reason: "addon_purchase",
      p_stripe_ref: session.id,
    });
  }
}

// deno-lint-ignore no-explicit-any
async function handleInvoicePaid(invoice: any, supabase: ReturnType<typeof createClient>) {
  if (invoice.billing_reason !== "subscription_cycle") return;

  const { data: profile } = await supabase
    .from("profiles").select("id")
    .eq("stripe_customer_id", invoice.customer).single();
  if (!profile) { console.error("No user for Stripe customer:", invoice.customer); return; }

  const { data: balance } = await supabase
    .from("credit_balance").select("plan_credits_per_cycle")
    .eq("account_id", profile.id).single();
  if (!balance?.plan_credits_per_cycle) return;

  await supabase.rpc("grant_credits", {
    p_account_id: profile.id,
    p_bucket: "subscription",
    p_amount: balance.plan_credits_per_cycle,
    p_reason: "monthly_reset",
    p_stripe_ref: invoice.id,
    p_set_not_increment: true,
  });
}

// deno-lint-ignore no-explicit-any
async function handleSubscriptionDeleted(subscription: any, supabase: ReturnType<typeof createClient>) {
  const { data: profile } = await supabase
    .from("profiles").select("id")
    .eq("stripe_customer_id", subscription.customer).single();
  if (!profile) return;

  await supabase.from("credit_balance")
    .update({ plan_credits_per_cycle: 0 })
    .eq("account_id", profile.id);
}
