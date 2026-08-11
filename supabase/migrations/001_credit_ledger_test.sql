-- ============================================================
-- Redink Credit Ledger — Unit Tests
-- Run AFTER 001_credit_ledger.sql in the Supabase SQL Editor.
-- The outer BEGIN/ROLLBACK ensures no data persists.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_uid   UUID := gen_random_uuid();
  v_result JSONB;
  v_sub    INTEGER;
  v_addon  INTEGER;
  v_api    INTEGER;
BEGIN
  -- ── Seed: insert a test auth.users row (superuser only) ──
  INSERT INTO auth.users (id, email, created_at, updated_at, aud, role)
  VALUES (v_uid, 'test-ledger@redink.ink', NOW(), NOW(), 'authenticated', 'authenticated');

  -- Seed balances directly (bypasses trigger which would also grant 3)
  INSERT INTO credit_balance (account_id, subscription_credits, addon_credits, api_balance)
  VALUES (v_uid, 5, 3, 10)
  ON CONFLICT (account_id) DO UPDATE
    SET subscription_credits = 5, addon_credits = 3, api_balance = 10;

  -- ── Test 1: credits_for() formula ────────────────────────
  ASSERT credits_for(1)  = 1, 'credits_for(1) should be 1';
  ASSERT credits_for(10) = 1, 'credits_for(10) should be 1';
  ASSERT credits_for(11) = 2, 'credits_for(11) should be 2';
  ASSERT credits_for(50) = 5, 'credits_for(50) should be 5';
  RAISE NOTICE 'Test 1 PASS: credits_for()';

  -- ── Test 2: Basic charge from subscription first ─────────
  v_result := charge_credits(v_uid, ARRAY['subscription','addon'], 3, 'job-t02', 'markup_job');
  ASSERT (v_result->>'ok') = 'true', 'T2: charge should return ok';
  SELECT subscription_credits, addon_credits INTO v_sub, v_addon
  FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub = 2,  'T2: subscription_credits should be 2 (was 5, used 3)';
  ASSERT v_addon = 3,'T2: addon_credits should be untouched (still 3)';
  RAISE NOTICE 'Test 2 PASS: basic charge hits subscription first';

  -- ── Test 3: Idempotency — same job_id no-ops ─────────────
  v_result := charge_credits(v_uid, ARRAY['subscription','addon'], 3, 'job-t02', 'markup_job');
  ASSERT (v_result->>'idempotent') = 'true', 'T3: second call with same job_id should be idempotent';
  SELECT subscription_credits INTO v_sub FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub = 2, 'T3: balance must be unchanged after idempotent call';
  RAISE NOTICE 'Test 3 PASS: idempotency guard';

  -- ── Test 4: Spill from subscription into addon ────────────
  -- subscription=2, addon=3, need 4 → use 2 from sub + 2 from addon
  v_result := charge_credits(v_uid, ARRAY['subscription','addon'], 4, 'job-t04', 'markup_job');
  ASSERT (v_result->>'ok') = 'true', 'T4: spill charge ok';
  SELECT subscription_credits, addon_credits INTO v_sub, v_addon
  FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub   = 0, 'T4: subscription_credits should be 0 (2 used)';
  ASSERT v_addon = 1, 'T4: addon_credits should be 1 (had 3, used 2)';
  RAISE NOTICE 'Test 4 PASS: spills from subscription into addon';

  -- ── Test 5: Insufficient credits raises exception ─────────
  BEGIN
    v_result := charge_credits(v_uid, ARRAY['subscription','addon'], 10, 'job-t05', 'markup_job');
    ASSERT false, 'T5: should have raised INSUFFICIENT_CREDITS';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%INSUFFICIENT_CREDITS%',
      'T5: wrong exception raised: ' || SQLERRM;
  END;
  -- Balances unchanged after failed charge
  SELECT subscription_credits, addon_credits INTO v_sub, v_addon
  FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub   = 0, 'T5: sub unchanged after failed charge';
  ASSERT v_addon = 1, 'T5: addon unchanged after failed charge';
  RAISE NOTICE 'Test 5 PASS: insufficient credits rolls back cleanly';

  -- ── Test 6: api_balance is isolated ──────────────────────
  -- subscription=0, addon=1, api=10
  -- Human charge cannot touch api_balance
  BEGIN
    v_result := charge_credits(v_uid, ARRAY['subscription','addon'], 5, 'job-t06h', 'markup_job');
    ASSERT false, 'T6h: human charge should fail (only 1 credit available)';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%INSUFFICIENT_CREDITS%', 'T6h: wrong exception';
  END;
  SELECT api_balance INTO v_api FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_api = 10, 'T6h: api_balance untouched by failed human charge';

  -- Agent charge draws from api only, not human buckets
  v_result := charge_credits(v_uid, ARRAY['api'], 4, 'job-t06a', 'markup_job');
  ASSERT (v_result->>'ok') = 'true', 'T6a: agent charge ok';
  SELECT subscription_credits, addon_credits, api_balance INTO v_sub, v_addon, v_api
  FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub   = 0, 'T6a: subscription unchanged by agent charge';
  ASSERT v_addon = 1, 'T6a: addon unchanged by agent charge';
  ASSERT v_api   = 6, 'T6a: api_balance should be 6 (had 10, used 4)';
  RAISE NOTICE 'Test 6 PASS: api_balance isolated from human buckets';

  -- ── Test 7: grant_credits (increment mode) ────────────────
  v_result := grant_credits(v_uid, 'addon', 10, 'addon_purchase', 'ch_test_123');
  SELECT addon_credits INTO v_addon FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_addon = 11, 'T7: addon_credits should be 11 (was 1, granted 10)';
  RAISE NOTICE 'Test 7 PASS: grant_credits increments addon';

  -- ── Test 8: grant_credits (set mode — subscription reset) ─
  v_result := grant_credits(v_uid, 'subscription', 50, 'plan_reset', NULL, TRUE);
  SELECT subscription_credits INTO v_sub FROM credit_balance WHERE account_id = v_uid;
  ASSERT v_sub = 50, 'T8: subscription_credits should be SET to 50 (not incremented)';
  -- Verify credits_reset_at was stamped
  ASSERT (SELECT credits_reset_at IS NOT NULL FROM credit_balance WHERE account_id = v_uid),
    'T8: credits_reset_at should be set';
  RAISE NOTICE 'Test 8 PASS: grant_credits set-mode (subscription reset)';

  -- ── Test 9: Transaction ledger has correct row count ──────
  -- We charged: T2(sub=3), T4(sub=2,addon=2), T6a(api=4), granted T7(addon+10), T8(sub set 50)
  -- Plus setup INSERT, plus signup_bonus (from trigger on INSERT into auth.users)
  -- At minimum T2 + T4-sub + T4-addon + T6a + T7-grant + T8-grant = 6 spend/grant rows
  ASSERT (
    SELECT COUNT(*) FROM credit_transactions WHERE account_id = v_uid
  ) >= 6, 'T9: expected at least 6 transaction rows';
  RAISE NOTICE 'Test 9 PASS: transaction ledger populated';

  RAISE NOTICE '';
  RAISE NOTICE '✓ All 9 tests passed.';
END;
$$;

ROLLBACK;
