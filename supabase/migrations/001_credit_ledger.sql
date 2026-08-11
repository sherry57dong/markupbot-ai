-- ============================================================
-- Redink Credit Ledger — Migration 001
-- Run in Supabase SQL Editor (project → SQL Editor → New query)
-- Safe to run multiple times (all statements are idempotent).
-- ============================================================

-- ── 1. credit_balance ──────────────────────────────────────
-- One row per account. Three buckets that never commingle.
-- CHECK constraints enforce non-negative at the DB layer.
CREATE TABLE IF NOT EXISTS public.credit_balance (
  account_id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_credits  INTEGER NOT NULL DEFAULT 0 CHECK (subscription_credits >= 0),
  addon_credits         INTEGER NOT NULL DEFAULT 0 CHECK (addon_credits >= 0),
  api_balance           INTEGER NOT NULL DEFAULT 0 CHECK (api_balance >= 0),
  -- plan_credits_per_cycle: how many subscription_credits to SET on monthly reset
  -- 0 = no active plan (free / cancelled)
  plan_credits_per_cycle INTEGER NOT NULL DEFAULT 0,
  -- credits_reset_at: timestamp of last subscription reset, used to guard
  -- against double-resets within the same billing cycle
  credits_reset_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.credit_balance ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credit_balance' AND policyname = 'Users can view own credit_balance'
  ) THEN
    CREATE POLICY "Users can view own credit_balance"
      ON public.credit_balance FOR SELECT
      USING (auth.uid() = account_id);
  END IF;
END $$;

-- ── 2. credit_transactions ─────────────────────────────────
-- Append-only ledger. Balances are derived; never blind-mutate.
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket      TEXT        NOT NULL CHECK (bucket IN ('subscription', 'addon', 'api')),
  delta       INTEGER     NOT NULL,   -- positive = grant, negative = spend
  reason      TEXT        NOT NULL,   -- 'signup_bonus' | 'plan_reset' | 'markup_job' |
                                      -- 'addon_purchase' | 'api_topup' | 'migration_from_v1'
  job_id      TEXT,                   -- idempotency key for spend operations
  stripe_ref  TEXT,                   -- Stripe charge / invoice ID for grant operations
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only enforce uniqueness when job_id is present
CREATE UNIQUE INDEX IF NOT EXISTS uidx_credit_tx_job_bucket
  ON public.credit_transactions (job_id, bucket)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_tx_account
  ON public.credit_transactions (account_id, created_at DESC);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credit_transactions' AND policyname = 'Users can view own transactions'
  ) THEN
    CREATE POLICY "Users can view own transactions"
      ON public.credit_transactions FOR SELECT
      USING (auth.uid() = account_id);
  END IF;
END $$;

-- ── 3. Shared helpers ──────────────────────────────────────

-- credits_for: the canonical cost formula used everywhere
CREATE OR REPLACE FUNCTION public.credits_for(p_page_count INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CEIL(p_page_count::NUMERIC / 10)::INTEGER;
$$;

-- ── 4. charge_credits — the atomic deduct-on-success primitive
-- p_account_id     : the account to charge
-- p_bucket_priority: ordered list of buckets to draw from, e.g.
--     ARRAY['subscription','addon']  (human web app)
--     ARRAY['api']                   (agent / API key)
-- p_credits        : number of credits to deduct
-- p_job_id         : idempotency key (UUID); NULL disables idempotency guard
-- p_reason         : label written to credit_transactions.reason
--
-- Returns: {"ok": true} or {"ok": true, "idempotent": true}
-- Raises:  INSUFFICIENT_CREDITS | ACCOUNT_NOT_FOUND
CREATE OR REPLACE FUNCTION public.charge_credits(
  p_account_id      UUID,
  p_bucket_priority TEXT[],
  p_credits         INTEGER,
  p_job_id          TEXT    DEFAULT NULL,
  p_reason          TEXT    DEFAULT 'markup_job'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credits_needed INTEGER := p_credits;
  v_bucket         TEXT;
  v_available      INTEGER;
  v_deduct         INTEGER;
  v_sub            INTEGER;
  v_addon          INTEGER;
  v_api            INTEGER;
  v_total          INTEGER := 0;
BEGIN
  -- Idempotency guard: if this job_id already has a spend row, return early
  IF p_job_id IS NOT NULL THEN
    PERFORM 1 FROM credit_transactions
    WHERE job_id = p_job_id
      AND account_id = p_account_id
      AND delta < 0
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true);
    END IF;
  END IF;

  -- Lock the balance row to prevent concurrent race
  SELECT subscription_credits, addon_credits, api_balance
  INTO v_sub, v_addon, v_api
  FROM credit_balance
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
  END IF;

  -- Sum available credits across the requested buckets
  FOREACH v_bucket IN ARRAY p_bucket_priority LOOP
    v_total := v_total + CASE v_bucket
      WHEN 'subscription' THEN v_sub
      WHEN 'addon'        THEN v_addon
      WHEN 'api'          THEN v_api
      ELSE 0
    END;
  END LOOP;

  IF v_total < p_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
  END IF;

  -- Deduct from each bucket in priority order
  FOREACH v_bucket IN ARRAY p_bucket_priority LOOP
    EXIT WHEN v_credits_needed <= 0;

    v_available := CASE v_bucket
      WHEN 'subscription' THEN v_sub
      WHEN 'addon'        THEN v_addon
      WHEN 'api'          THEN v_api
      ELSE 0
    END;

    v_deduct := LEAST(v_available, v_credits_needed);
    CONTINUE WHEN v_deduct <= 0;

    CASE v_bucket
      WHEN 'subscription' THEN
        UPDATE credit_balance
        SET subscription_credits = subscription_credits - v_deduct, updated_at = NOW()
        WHERE account_id = p_account_id;
        v_sub := v_sub - v_deduct;
      WHEN 'addon' THEN
        UPDATE credit_balance
        SET addon_credits = addon_credits - v_deduct, updated_at = NOW()
        WHERE account_id = p_account_id;
        v_addon := v_addon - v_deduct;
      WHEN 'api' THEN
        UPDATE credit_balance
        SET api_balance = api_balance - v_deduct, updated_at = NOW()
        WHERE account_id = p_account_id;
        v_api := v_api - v_deduct;
    END CASE;

    -- The unique index on (job_id, bucket) is the final race guard;
    -- a concurrent duplicate will fail here and roll back everything above.
    INSERT INTO credit_transactions (account_id, bucket, delta, reason, job_id)
    VALUES (p_account_id, v_bucket, -v_deduct, p_reason, p_job_id);

    v_credits_needed := v_credits_needed - v_deduct;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'credits_charged', p_credits);
END;
$$;

-- ── 5. grant_credits — used by Stripe webhooks and admin
-- p_set_not_increment = TRUE for subscription resets (no rollover)
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_account_id        UUID,
  p_bucket            TEXT,
  p_amount            INTEGER,
  p_reason            TEXT,
  p_stripe_ref        TEXT    DEFAULT NULL,
  p_set_not_increment BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_set_not_increment THEN
    -- Subscription reset: SET to plan amount (no rollover)
    IF p_bucket <> 'subscription' THEN
      RAISE EXCEPTION 'set_not_increment is only valid for the subscription bucket';
    END IF;
    UPDATE credit_balance
    SET subscription_credits = p_amount,
        credits_reset_at     = NOW(),
        updated_at           = NOW()
    WHERE account_id = p_account_id;
  ELSE
    CASE p_bucket
      WHEN 'subscription' THEN
        UPDATE credit_balance
        SET subscription_credits = subscription_credits + p_amount, updated_at = NOW()
        WHERE account_id = p_account_id;
      WHEN 'addon' THEN
        UPDATE credit_balance
        SET addon_credits = addon_credits + p_amount, updated_at = NOW()
        WHERE account_id = p_account_id;
      WHEN 'api' THEN
        UPDATE credit_balance
        SET api_balance = api_balance + p_amount, updated_at = NOW()
        WHERE account_id = p_account_id;
      ELSE
        RAISE EXCEPTION 'Unknown bucket: %', p_bucket;
    END CASE;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
  END IF;

  INSERT INTO credit_transactions (account_id, bucket, delta, reason, stripe_ref)
  VALUES (p_account_id, p_bucket, p_amount, p_reason, p_stripe_ref);

  RETURN jsonb_build_object('ok', true, 'granted', p_amount);
END;
$$;

-- ── 6. Update handle_new_user trigger ──────────────────────
-- Initialises credit_balance with 3 signup-bonus credits
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.credit_balance (account_id, subscription_credits)
  VALUES (NEW.id, 3)
  ON CONFLICT (account_id) DO NOTHING;

  INSERT INTO public.credit_transactions (account_id, bucket, delta, reason)
  VALUES (NEW.id, 'subscription', 3, 'signup_bonus');

  RETURN NEW;
END;
$$;

-- ── 7. Migrate existing users ──────────────────────────────
-- Seed credit_balance from profiles.credits_remaining for users
-- who existed before this migration. ON CONFLICT = safe to re-run.
INSERT INTO public.credit_balance (account_id, subscription_credits, plan_credits_per_cycle)
SELECT id, GREATEST(COALESCE(credits_remaining, 0), 0), 0
FROM public.profiles
ON CONFLICT (account_id) DO NOTHING;

-- Ledger records for migrated non-zero balances
INSERT INTO public.credit_transactions (account_id, bucket, delta, reason)
SELECT id, 'subscription', credits_remaining, 'migration_from_v1'
FROM public.profiles
WHERE COALESCE(credits_remaining, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.credit_transactions ct
    WHERE ct.account_id = profiles.id AND ct.reason = 'migration_from_v1'
  );
